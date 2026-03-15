// ─────────────────────────────────────────────────────────────
//  Arise Dothan — Giving Backend
//  Handles Stripe payment intents, subscriptions + Supabase records
// ─────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const Stripe  = require("stripe");
const { createClient } = require("@supabase/supabase-js");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY environment variable is not set.");
  return Stripe(key);
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  "https://pqgmmvxcxmhpdorvrjfk.supabase.co",
  process.env.SUPABASE_SERVICE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxZ21tdnhjeG1ocGRvcnZyamZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MzM0ODksImV4cCI6MjA4ODUwOTQ4OX0.fu2CWqHUAbt9ykN5sIC4FBV7lVIXECRU1DimYPu0DpI"
);

// ── Middleware ────────────────────────────────────────────────
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors({
  origin: [
    "https://arisedothan.com",
    "http://localhost:3000",
    /\.netlify\.app$/,
    /\.render\.com$/,
    /\.github\.io$/,
  ]
}));

// ── Fund → Donation Type mapping ─────────────────────────────
const FUND_TYPE_MAP = {
  "General Fund":  "General Fund",
  "Building Fund": "Building Fund",
  "Missions Fund": "Missions",
  "Youth Fund":    "Special Gift",
  "Worship Fund":  "Special Gift",
};

// ── Shared: upsert donor, return donor id ─────────────────────
async function upsertDonor(donorName, donorEmail) {
  const nameParts = (donorName || "").trim().split(" ");
  const firstName = nameParts[0] || "";
  const lastName  = nameParts.slice(1).join(" ") || "";
  const email     = (donorEmail || "").toLowerCase().trim();
  if (!email) return null; // Cannot upsert without email

  // 1. Look up by email — case-insensitive
  const { data: existing } = await supabase
    .from("donors")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (existing) return existing.id;

  // 2. No email match — check if a donor with the same name exists (admin-created records
  //    often have no email). If found, stamp email onto that record instead of creating new.
  if (firstName && lastName) {
    const { data: nameMatch } = await supabase
      .from("donors")
      .select("id, email")
      .ilike("first_name", firstName)
      .ilike("last_name", lastName)
      .maybeSingle();
    if (nameMatch) {
      // Stamp email onto the existing record so future lookups find it by email
      if (!nameMatch.email) {
        await supabase.from("donors").update({ email }).eq("id", nameMatch.id);
      }
      return nameMatch.id;
    }
  }

  // 3. No match at all — create new donor
  const { data: inserted, error: insertErr } = await supabase
    .from("donors")
    .insert({ first_name: firstName, last_name: lastName, email })
    .select("id")
    .single();
  if (insertErr) {
    // Likely a race condition duplicate — try selecting again
    const { data: retry } = await supabase
      .from("donors").select("id").eq("email", email).maybeSingle();
    return retry?.id || null;
  }
  return inserted?.id || null;
}

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Arise Dothan Giving API" });
});

// ── POST /create-payment-intent  (one-time giving) ────────────
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, giftAmount, fund, donorName, donorEmail, freq, coverFees } = req.body;
    if (!amount || amount < 1)        return res.status(400).json({ error: "Invalid amount" });
    if (!donorName || !donorEmail)    return res.status(400).json({ error: "Donor name and email required" });

    const chargeCents  = Math.round(parseFloat(amount) * 100);
    const recordedGift = giftAmount ? parseFloat(giftAmount) : parseFloat(amount);
    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount:        chargeCents,
      currency:      "usd",
      receipt_email: donorEmail,
      description:   `${fund || "General Fund"} — Arise Dothan`,
      metadata: {
        donorName, donorEmail,
        fund:       fund      || "General Fund",
        freq:       freq      || "one-time",
        giftAmount: String(recordedGift),
        coverFees:  String(coverFees || false),
        source:     "giving-app",
      },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("PaymentIntent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /create-subscription  (weekly or monthly giving) ─────
// Flow:
//   1. Find or create a Stripe Customer for this email
//   2. Attach the payment method to the customer & set as default
//   3. Find or create a Stripe Price for this fund+amount+interval
//   4. Create a Subscription (charges immediately for first period)
//   5. Return { subscriptionId, clientSecret } so the frontend can
//      confirm the first payment with the card element
app.post("/create-subscription", async (req, res) => {
  try {
    const { amount, giftAmount, fund, donorName, donorEmail, freq, coverFees, paymentMethodId } = req.body;
    if (!amount || amount < 1)        return res.status(400).json({ error: "Invalid amount" });
    if (!donorName || !donorEmail)    return res.status(400).json({ error: "Donor name and email required" });
    if (!paymentMethodId)             return res.status(400).json({ error: "Payment method required" });
    if (!["weekly","monthly"].includes(freq)) return res.status(400).json({ error: "Invalid frequency" });

    const stripe       = getStripe();
    const chargeCents  = Math.round(parseFloat(amount) * 100);
    const recordedGift = giftAmount ? parseFloat(giftAmount) : parseFloat(amount);
    const interval     = freq === "weekly" ? "week" : "month";
    const fundName     = fund || "General Fund";
    // 1. Find or create Stripe Customer
    const existing = await stripe.customers.list({ email: donorEmail, limit: 1 });
    let customer = existing.data[0];
    if (!customer) {
      customer = await stripe.customers.create({
        email: donorEmail,
        name:  donorName,
        metadata: { source: "giving-app" },
      });
    }

    // 2. Attach payment method & set as default
    //    Wrap in try/catch — Stripe throws if PM is already attached to this customer
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    } catch (attachErr) {
      if (!attachErr.message?.includes("already been attached")) throw attachErr;
    }
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // 3. Create a Price inline on the product
    //    Use a product per fund so the Stripe dashboard is clean
    const productId = `arise_${fundName.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"")}`;
    let product;
    try {
      product = await stripe.products.retrieve(productId);
      // If product exists but is archived, create a fresh one with a unique ID
      if (!product.active) {
        product = await stripe.products.create({ id: `${productId}_${Date.now()}`, name: `${fundName} — Arise Dothan` });
      }
    } catch (productErr) {
      // Product doesn't exist — create it
      // Guard against race condition: two simultaneous subscriptions for the same fund
      // could both hit "No such product" and then both try to create it
      try {
        product = await stripe.products.create({ id: productId, name: `${fundName} — Arise Dothan` });
      } catch (createErr) {
        if (createErr.message?.includes("already exists")) {
          // Other request won the race — retrieve the product they created
          product = await stripe.products.retrieve(productId);
        } else {
          throw createErr;
        }
      }
    }
    const price = await stripe.prices.create({
      unit_amount: chargeCents,
      currency:    "usd",
      recurring:   { interval },
      product:     product.id,
      metadata:    { fundName, interval },
    });

    // 4. Create subscription — payment_behavior: default_incomplete means
    //    first invoice needs explicit confirmation (we return the clientSecret)
    const subscription = await stripe.subscriptions.create({
      customer:         customer.id,
      items:            [{ price: price.id }],
      payment_behavior: "default_incomplete",
      payment_settings: { payment_method_types: ["card"], save_default_payment_method: "on_subscription" },
      expand:           ["latest_invoice.payment_intent"],
      metadata: {
        donorName, donorEmail,
        fund:       fundName,
        freq,
        giftAmount: String(recordedGift),
        coverFees:  String(coverFees || false),
        source:     "giving-app",
      },
    });

    const paymentIntent = subscription.latest_invoice?.payment_intent;
    if (!paymentIntent?.client_secret) {
      throw new Error("Subscription created but no payment required — contact support if unexpected.");
    }
    const clientSecret = paymentIntent.client_secret;
    res.json({
      subscriptionId: subscription.id,
      clientSecret,
      customerId: customer.id,
    });
  } catch (err) {
    console.error("Subscription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /cancel-subscription ─────────────────────────────────
app.post("/cancel-subscription", async (req, res) => {
  try {
    const { subscriptionId, donorEmail } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });
    if (!donorEmail)       return res.status(400).json({ error: "donorEmail required" });
    const stripe = getStripe();
    // Verify the subscription belongs to this email before cancelling
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customer = await stripe.customers.retrieve(sub.customer);
    // Guard: deleted customers have no email — fall back to subscription metadata
    const custEmail = customer.deleted
      ? sub.metadata?.donorEmail || ""
      : (customer.email || "");
    if (custEmail.toLowerCase().trim() !== (donorEmail||"").toLowerCase().trim()) {
      return res.status(403).json({ error: "Subscription does not belong to this donor" });
    }
    await stripe.subscriptions.cancel(subscriptionId);
    res.json({ cancelled: true });
  } catch (err) {
    console.error("Cancel subscription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /subscriptions/:email ─────────────────────────────────
app.get("/subscriptions/:email", async (req, res) => {
  try {
    const stripe = getStripe();
    const email  = decodeURIComponent(req.params.email).toLowerCase().trim();

    // Search by email (case-insensitive by normalising before lookup)
    const customers = await stripe.customers.list({ email, limit: 5 });
    const custIds = new Set(customers.data.map(c => c.id));

    // Also search with original casing in case Stripe stored it differently
    const originalEmail = decodeURIComponent(req.params.email).trim();
    if (originalEmail !== email) {
      const customers2 = await stripe.customers.list({ email: originalEmail, limit: 5 });
      customers2.data.forEach(c => custIds.add(c.id));
    }

    if (!custIds.size) return res.json({ subscriptions: [] });

    const subMap = new Map(); // dedup by sub.id
    for (const custId of custIds) {
      // No expand — we rely entirely on metadata (fund, freq, giftAmount) stored at creation
      const subs = await stripe.subscriptions.list({ customer: custId, status: "active", limit: 20 });
      subs.data.forEach(sub => {
        if (subMap.has(sub.id)) return;
        // Only return subs created by this app
        if (sub.metadata?.source !== "giving-app") return;
        const item  = sub.items?.data?.[0];
        const price = item?.price;
        subMap.set(sub.id, {
          id:         sub.id,
          status:     sub.status,
          fund:       sub.metadata.fund || "General Fund",
          giftAmount: parseFloat(sub.metadata.giftAmount) || (price?.unit_amount || 0) / 100,
          freq:       sub.metadata.freq || price?.recurring?.interval || "monthly",
          coverFees:  sub.metadata.coverFees === "true",
          created:    new Date(sub.created * 1000).toISOString().split("T")[0],
          current_period_end: new Date(sub.current_period_end * 1000).toISOString().split("T")[0],
        });
      });
    }
    res.json({ subscriptions: [...subMap.values()] });
  } catch (err) {
    console.error("Get subscriptions error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/subscriptions  (active + paused, for admin portal) ──
app.get("/admin/subscriptions", async (req, res) => {
  try {
    const stripe = getStripe();
    // Fetch both active and paused subscriptions in parallel
    const [activeSubs, pausedSubs] = await Promise.all([
      stripe.subscriptions.list({ status: "active", limit: 100, expand: ["data.customer","data.items.data.price"] }),
      stripe.subscriptions.list({ status: "paused", limit: 100, expand: ["data.customer","data.items.data.price"] }),
    ]);
    const allSubs = [...activeSubs.data, ...pausedSubs.data];
    const result = allSubs.map(sub => {
      const item  = sub.items.data[0];
      const price = item?.price;
      const cust  = sub.customer;
      return {
        id:          sub.id,
        itemId:      item?.id || null,
        donorName:   sub.metadata.donorName  || (typeof cust === "object" ? cust.name  : ""),
        donorEmail:  sub.metadata.donorEmail || (typeof cust === "object" ? cust.email : ""),
        fund:        sub.metadata.fund       || "General Fund",
        amount:      (price?.unit_amount || 0) / 100,
        giftAmount:  parseFloat(sub.metadata.giftAmount || (price?.unit_amount||0)/100),
        freq:        sub.metadata.freq       || price?.recurring?.interval,
        status:      sub.status,
        paused:      !!sub.pause_collection,
        created:     new Date(sub.created * 1000).toISOString().split("T")[0],
        current_period_end: new Date(sub.current_period_end * 1000).toISOString().split("T")[0],
      };
    });
    res.json({ subscriptions: result });
  } catch (err) {
    console.error("Admin subscriptions error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/cancel-subscription  (admin portal) ────────────
app.post("/admin/cancel-subscription", async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });
    const stripe = getStripe();

    // Retrieve sub metadata BEFORE cancelling so we have donor info for the email
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const { donorName, donorEmail, fund, freq, giftAmount } = sub.metadata || {};

    await stripe.subscriptions.cancel(subscriptionId);

    // Send cancellation email via Resend if API key is configured and we have an email
    if (process.env.RESEND_API_KEY && donorEmail) {
      const freqLabel = freq === "weekly" ? "weekly" : "monthly";
      const amtLabel  = giftAmount ? `$${parseFloat(giftAmount).toFixed(2)}` : "your recurring gift";
      const fundLabel = fund || "General Fund";
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from:    process.env.EMAIL_FROM || "giving@arisedothan.com",
            to:      donorEmail,
            subject: "Your Recurring Gift Has Been Cancelled \u2014 Arise Dothan",
            html: `
              <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0A1A2E">
                <div style="background:#0752BC;padding:24px 32px;border-radius:10px 10px 0 0">
                  <div style="color:#fff;font-size:1.2rem;font-weight:800;letter-spacing:.3px">Arise Dothan</div>
                  <div style="color:rgba(255,255,255,.75);font-size:.8rem;margin-top:2px">Giving Notification</div>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #E6F0FC;border-top:none;border-radius:0 0 10px 10px">
                  <p style="font-size:1rem;margin-bottom:18px">Hi ${donorName || "there"},</p>
                  <p style="font-size:.93rem;line-height:1.6;margin-bottom:18px">
                    We want to let you know that your <strong>${freqLabel} recurring gift</strong> of
                    <strong>${amtLabel}</strong> to the <strong>${fundLabel}</strong> has been cancelled
                    at the request of our team.
                  </p>
                  <p style="font-size:.93rem;line-height:1.6;margin-bottom:18px">
                    No further charges will be made. If you have any questions or would like to
                    set up a new recurring gift, please visit our giving portal or contact us directly.
                  </p>
                  <a href="https://arisedothan.com" style="display:inline-block;background:#0752BC;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.88rem">Visit Giving Portal</a>
                  <p style="margin-top:28px;font-size:.8rem;color:#6B8BB5">
                    Thank you for your generosity and support of Arise Dothan.<br>
                    Dothan, Alabama
                  </p>
                </div>
              </div>`,
          }),
        });
        console.log("[CANCEL EMAIL] Sent to " + donorEmail);
      } catch (emailErr) {
        // Non-fatal \u2014 log but don't fail the cancellation
        console.error("[CANCEL EMAIL] Failed:", emailErr.message);
      }
    }

    res.json({ cancelled: true });
  } catch (err) {
    console.error("Admin cancel subscription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook ─────────────────────────────────────────────

// ── POST /admin/pause-subscription ──────────────────────────────
app.post("/admin/pause-subscription", async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });
    const stripe = getStripe();
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: "void" },
    });
    res.json({ paused: true });
  } catch (err) {
    console.error("Pause subscription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/resume-subscription ─────────────────────────────
app.post("/admin/resume-subscription", async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });
    const stripe = getStripe();
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: "",
    });
    res.json({ resumed: true });
  } catch (err) {
    console.error("Resume subscription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/edit-subscription ────────────────────────────────
// Updates the gift amount and/or fund on an existing subscription.
// Creates a new Stripe Price for the new amount and swaps it onto the
// subscription item, then updates metadata so webhooks record correctly.
app.post("/admin/edit-subscription", async (req, res) => {
  try {
    const { subscriptionId, itemId, newAmount, newFund, freq } = req.body;
    if (!subscriptionId || !itemId) return res.status(400).json({ error: "subscriptionId and itemId required" });
    if (!newAmount || newAmount < 1)  return res.status(400).json({ error: "Invalid amount" });

    const stripe      = getStripe();
    const chargeCents = Math.round(parseFloat(newAmount) * 100);
    const fundName    = newFund || "General Fund";
    const interval    = (freq === "weekly" || freq === "week") ? "week" : "month";

    // Find or create Stripe Product for this fund (mirrors create-subscription logic)
    const productId = `arise_${fundName.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"")}`;
    let product;
    try {
      product = await stripe.products.retrieve(productId);
      if (!product.active) {
        product = await stripe.products.create({ id: `${productId}_${Date.now()}`, name: `${fundName} — Arise Dothan` });
      }
    } catch {
      try {
        product = await stripe.products.create({ id: productId, name: `${fundName} — Arise Dothan` });
      } catch (createErr) {
        if (createErr.message?.includes("already exists")) {
          product = await stripe.products.retrieve(productId);
        } else {
          throw createErr;
        }
      }
    }

    // Create a new Price for the updated amount
    const newPrice = await stripe.prices.create({
      unit_amount: chargeCents,
      currency:    "usd",
      recurring:   { interval },
      product:     product.id,
      metadata:    { fundName, interval },
    });

    // Swap the subscription item to the new price and update metadata
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, price: newPrice.id }],
      metadata: { fund: fundName, giftAmount: String(parseFloat(newAmount)) },
      proration_behavior: "none",
    });

    res.json({ updated: true });
  } catch (err) {
    console.error("Edit subscription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log every webhook event received — plain ASCII for Render compatibility
  console.log("[WEBHOOK] Received event type: " + event.type + " id: " + event.id);

  // ── One-time payment succeeded ────────────────────────────
  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    // Skip if this PI belongs to a subscription invoice — handled by invoice.payment_succeeded
    // Also skip PIs not created by this app (e.g. Stripe dashboard test charges)
    if (!pi.invoice && pi.metadata?.source === "giving-app") {
      const { donorName, donorEmail, fund, freq, giftAmount, coverFees } = pi.metadata;
      const recordedAmount = giftAmount ? parseFloat(giftAmount) : pi.amount / 100;
      const today          = new Date().toISOString().split("T")[0];
      const freqLabel      = freq === "one-time" ? "One-Time" : (freq||"").charAt(0).toUpperCase()+(freq||"").slice(1);
      const feeNote        = coverFees === "true" ? " · Donor covered fees" : "";
      try {
        // Dedup check: guard against Stripe delivering payment_intent.succeeded twice
        const { data: dup } = await supabase
          .from("donations").select("id").ilike("notes", `%${pi.id}%`).maybeSingle();
        if (dup) { console.log(`⏭ Skipping duplicate one-time PI: ${pi.id}`); }
        else {
          const donorId = await upsertDonor(donorName, donorEmail);
          const donBody = {
            date:   today,
            donor:  donorName,
            type:   FUND_TYPE_MAP[fund] || "Offering",
            amount: recordedAmount,
            notes:  `${fund} · ${freqLabel}${feeNote} · Stripe ${pi.id}`,
          };
          if (donorId) donBody.donor_id = donorId;
          console.log("[ONE-TIME] Attempting insert: " + donorName + " $" + recordedAmount + " -> " + fund);
          const { error } = await supabase.from("donations").insert(donBody);
          if (error) {
            console.error("[ERROR] Supabase insert error: " + error.message + " code: " + error.code);
            throw new Error("Supabase insert failed: " + error.message);
          }
          console.log("[ONE-TIME] SUCCESS: " + donorName + " $" + recordedAmount + " -> " + fund);
        }
      } catch (err) { console.error("Supabase error:", err.message); }
    }

  // ── Recurring charge succeeded (subscription invoice) ────
  } else if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    // Stripe API versions differ on where subscription ID lives — check all known locations
    const subscriptionId = invoice.subscription
      || invoice.parent?.subscription_details?.subscription
      || invoice.lines?.data?.[0]?.subscription
      || invoice.lines?.data?.[0]?.parent?.subscription_details?.subscription;
    console.log("[RECURRING] subscriptionId: " + subscriptionId + " | billing_reason: " + invoice.billing_reason + " | invoice.id: " + invoice.id);
    // Only process subscription invoices
    if (subscriptionId) {
      try {
        // Dedup: Stripe may deliver invoice.payment_succeeded more than once
        console.log("[RECURRING] Checking dedup for invoice: " + invoice.id);
        const { data: dup, error: dupErr } = await supabase
          .from("donations").select("id").ilike("notes", "%" + invoice.id + "%").maybeSingle();
        if (dupErr) console.error("[RECURRING] Dedup query error: " + dupErr.message + " code: " + dupErr.code);
        if (dup) { console.log("[RECURRING] Skipping duplicate invoice: " + invoice.id); }
        else {
          const stripe = getStripe();
          const sub    = await stripe.subscriptions.retrieve(subscriptionId);
          // Skip subscriptions not created by this app
          if (sub.metadata?.source !== "giving-app") return; // outer res.json() handles response
          const { donorName, donorEmail, fund, freq, giftAmount, coverFees } = sub.metadata;
          const recordedAmount = giftAmount ? parseFloat(giftAmount) : invoice.amount_paid / 100;
          const today          = new Date().toISOString().split("T")[0];
          const freqLabel      = freq ? freq.charAt(0).toUpperCase()+freq.slice(1) : "Recurring";
          const feeNote        = coverFees === "true" ? " · Donor covered fees" : "";
          const cycleLabel     = invoice.billing_reason === "subscription_create" ? "first charge" : "renewal";
          const donorId = await upsertDonor(donorName, donorEmail);
          const donBody = {
            date:   today,
            donor:  donorName,
            type:   FUND_TYPE_MAP[fund] || "Offering",
            amount: recordedAmount,
            notes:  `${fund} · ${freqLabel}${feeNote} · Sub ${sub.id} (${cycleLabel}) · Inv ${invoice.id}`,
          };
          if (donorId) donBody.donor_id = donorId;
          console.log("[RECURRING] Attempting insert: " + donorName + " $" + recordedAmount + " -> " + fund);
          console.log("[RECURRING] donBody: " + JSON.stringify(donBody));
          const { error } = await supabase.from("donations").insert(donBody);
          if (error) {
            console.error("❌ Supabase insert error:", error.message, "| code:", error.code, "| details:", error.details);
            throw new Error(`Supabase insert failed: ${error.message}`);
          }
          console.log("[RECURRING] SUCCESS: " + freqLabel + " " + donorName + " $" + recordedAmount + " -> " + fund + " (" + cycleLabel + ")");
        }
      } catch (err) { console.error("[RECURRING] ERROR: " + err.message + " | stack: " + (err.stack||"none")); }
    }
  }

  // Always send exactly one response
  res.json({ received: true });
});

// ── Start server ──────────────────────────────────────────────
// -- GET /admin/users  (list all portal users + roles) --------
app.get("/admin/users", async (req, res) => {
  try {
    const supabaseUrl = "https://pqgmmvxcxmhpdorvrjfk.supabase.co";
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
    if (!serviceKey) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY not configured on server" });
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=200`, {
      headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` }
    });
    if (!r.ok) throw new Error("Failed to fetch users from Supabase");
    const data = await r.json();
    const users = (data.users || [])
      .filter(u => ["admin","staff"].includes(u.user_metadata?.role))
      .map(u => ({
        id:           u.id,
        email:        u.email,
        name:         u.user_metadata?.name || "",
        role:         u.user_metadata?.role,
        created_at:   u.created_at,
        last_sign_in: u.last_sign_in_at || null,
      }));
    res.json({ users });
  } catch (err) {
    console.error("List users error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- POST /admin/invite-user -----------------------------------
app.post("/admin/invite-user", async (req, res) => {
  try {
    const { email, name, role } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!["admin","staff"].includes(role)) return res.status(400).json({ error: "Role must be admin or staff" });
    const supabaseUrl = "https://pqgmmvxcxmhpdorvrjfk.supabase.co";
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
    if (!serviceKey) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY not configured on server" });
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: { name: name || email.split("@")[0], role },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.msg || "Failed to create user");

    // Send access notification email via Resend if configured
    if (process.env.RESEND_API_KEY) {
      const roleLabel = role === "admin" ? "Admin" : "Staff";
      const displayName = name || email.split("@")[0];
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM || "giving@arisedothan.com",
            to:   email,
            subject: "You have been added to the Arise Dothan Portal",
            html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0A1A2E;">
              <div style="background:#0752BC;padding:24px 32px;border-radius:10px 10px 0 0;">
                <div style="color:#fff;font-size:1.2rem;font-weight:800;">Arise Dothan</div>
                <div style="color:rgba(255,255,255,.75);font-size:.8rem;margin-top:2px;">Portal Access</div>
              </div>
              <div style="background:#fff;padding:28px 32px;border:1px solid #E6F0FC;border-top:none;border-radius:0 0 10px 10px;">
                <p style="font-size:1rem;margin-bottom:18px;">Hi ${displayName},</p>
                <p style="font-size:.93rem;line-height:1.6;margin-bottom:18px;">
                  You have been granted <strong>${roleLabel}</strong> access to the Arise Dothan portal.
                  Visit the portal and sign in using this email address. If this is your first time,
                  use the <strong>Forgot Password</strong> link to set your password.
                </p>
                <a href="https://arisedothan.com" style="display:inline-block;background:#0752BC;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.88rem;">Go to Portal</a>
                <p style="margin-top:28px;font-size:.8rem;color:#6B8BB5;">Arise Dothan - Dothan, Alabama</p>
              </div>
            </div>`,
          }),
        });
        console.log("[INVITE EMAIL] Sent to " + email);
      } catch (emailErr) {
        console.error("[INVITE EMAIL] Failed:", emailErr.message);
      }
    }
    res.json({ invited: true, userId: data.id });
  } catch (err) {
    console.error("Invite user error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- PATCH /admin/update-user-role ----------------------------
app.patch("/admin/update-user-role", async (req, res) => {
  try {
    const { userId, role } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!["admin","staff","donor"].includes(role)) return res.status(400).json({ error: "Invalid role" });
    const supabaseUrl = "https://pqgmmvxcxmhpdorvrjfk.supabase.co";
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
    if (!serviceKey) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY not configured on server" });
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_metadata: { role } }),
    });
    if (!r.ok) {
      const d = await r.json().catch(()=>({}));
      throw new Error(d.message || "Failed to update role");
    }
    console.log("[USER MGMT] Updated user " + userId + " to role: " + role);
    res.json({ updated: true });
  } catch (err) {
    console.error("Update role error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- DELETE /admin/revoke-user --------------------------------
app.delete("/admin/revoke-user", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const supabaseUrl = "https://pqgmmvxcxmhpdorvrjfk.supabase.co";
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
    if (!serviceKey) return res.status(500).json({ error: "SUPABASE_SERVICE_KEY not configured on server" });
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` },
    });
    if (!r.ok && r.status !== 204) {
      const d = await r.json().catch(()=>({}));
      throw new Error(d.message || "Failed to revoke user");
    }
    console.log("[USER MGMT] Revoked user " + userId);
    res.json({ revoked: true });
  } catch (err) {
    console.error("Revoke user error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// -- POST /admin/send-giving-statements -----------------------
// Sends annual giving statements to one or more donors via Resend.
// Body: { year, statements: [{ donorName, donorEmail, address, accountNumber, ein, total, gifts }] }
app.post("/admin/send-giving-statements", async (req, res) => {
  try {
    const { year, statements } = req.body;
    if (!year || !Array.isArray(statements) || !statements.length)
      return res.status(400).json({ error: "year and statements array required" });
    if (!process.env.RESEND_API_KEY)
      return res.status(500).json({ error: "RESEND_API_KEY not configured on server" });

    const from = process.env.EMAIL_FROM || "giving@arisedothan.com";
    const results = { sent: 0, skipped: 0, failed: 0, errors: [] };

    for (const stmt of statements) {
      const { donorName, donorEmail, address, accountNumber, ein, total, gifts } = stmt;
      if (!donorEmail) { results.skipped++; continue; }

      const fmtAmt = n => Number(n||0).toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 });
      const giftRows = (gifts||[]).map((g,i) =>
        `<tr style="background:${i%2?"#E6F0FC":"#fff"}">
          <td style="padding:8px 12px;font-size:.85rem;border-bottom:1px solid #C8DCF5;">${g.date||""}</td>
          <td style="padding:8px 12px;font-size:.85rem;border-bottom:1px solid #C8DCF5;">${g.fund||""}</td>
          <td style="padding:8px 12px;font-size:.85rem;border-bottom:1px solid #C8DCF5;text-align:right;color:#7B8F43;font-weight:700;font-family:Montserrat,sans-serif;">$${fmtAmt(g.amount)}</td>
        </tr>`
      ).join("");

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0A1A2E;">
          <div style="background:#0752BC;padding:24px 32px;border-radius:10px 10px 0 0;">
            <div style="color:#fff;font-size:1.2rem;font-weight:800;">Arise Dothan</div>
            <div style="color:rgba(255,255,255,.75);font-size:.8rem;margin-top:2px;">Annual Giving Statement - Tax Year ${year}</div>
          </div>
          <div style="background:#fff;padding:28px 32px;border:1px solid #E6F0FC;border-top:none;border-radius:0 0 10px 10px;">

            <div style="border-bottom:1px solid #C8DCF5;padding-bottom:18px;margin-bottom:18px;">
              <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#6B8BB5;margin-bottom:5px;">Prepared For</div>
              <div style="font-size:1.05rem;font-weight:800;">${donorName}</div>
              ${address ? `<div style="font-size:.83rem;color:#6B8BB5;margin-top:3px;">${address}</div>` : ""}
              ${accountNumber ? `<div style="font-size:.68rem;font-weight:700;color:#0752BC;letter-spacing:1px;margin-top:4px;">Account # ${accountNumber}</div>` : ""}
            </div>

            <div style="background:#EAF0DC;border-radius:10px;padding:16px;margin-bottom:20px;border-left:4px solid #7B8F43;">
              <div style="font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#7B8F43;">Total Contributions - ${year}</div>
              <div style="font-size:2rem;font-weight:800;color:#7B8F43;font-family:Montserrat,sans-serif;">$${fmtAmt(total)}</div>
              <div style="font-size:.78rem;color:#6B8BB5;margin-top:2px;">${(gifts||[]).length} gift(s) recorded</div>
            </div>

            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
              <thead>
                <tr style="background:#E6F0FC;">
                  <th style="padding:9px 12px;text-align:left;font-size:.62rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0752BC;border-bottom:1px solid #C8DCF5;">Date</th>
                  <th style="padding:9px 12px;text-align:left;font-size:.62rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0752BC;border-bottom:1px solid #C8DCF5;">Fund</th>
                  <th style="padding:9px 12px;text-align:right;font-size:.62rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0752BC;border-bottom:1px solid #C8DCF5;">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${giftRows}
                <tr style="background:#EAF0DC;">
                  <td colspan="2" style="padding:9px 12px;font-weight:800;font-size:.82rem;">TOTAL</td>
                  <td style="padding:9px 12px;text-align:right;font-weight:800;color:#7B8F43;font-family:Montserrat,sans-serif;">$${fmtAmt(total)}</td>
                </tr>
              </tbody>
            </table>

            <div style="background:#FDF0DC;border-radius:8px;padding:14px;border-left:4px solid #BC6907;font-size:.8rem;color:#2E2E2E;line-height:1.6;">
              <strong style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#BC6907;display:block;margin-bottom:6px;">Contribution Notice</strong>
              Arise Dothan is a nonprofit religious corporation organized under the laws of the State of Alabama and authorized to receive charitable contributions.
              We are organized exclusively for religious purposes and are structured to qualify for federal tax-exempt status.
              No goods or services were provided in exchange for these contributions unless otherwise noted.
              Please consult your tax advisor regarding the deductibility of your gift. We appreciate your generous support.
              ${ein ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #F0D8A8;"><strong style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#BC6907;">Federal Tax ID (EIN):</strong> <span style="font-weight:700;">${ein}</span></div>` : ""}
            </div>

          </div>
        </div>`;

      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.RESEND_API_KEY },
          body: JSON.stringify({
            from,
            to: donorEmail,
            subject: `Your ${year} Annual Giving Statement - Arise Dothan`,
            html,
          }),
        });
        if (r.ok) {
          results.sent++;
          console.log("[BULK STMT] Sent to " + donorEmail);
        } else {
          const err = await r.json().catch(()=>({}));
          results.failed++;
          results.errors.push(`${donorEmail}: ${err.message||"send failed"}`);
          console.error("[BULK STMT] Failed for " + donorEmail + ":", err.message);
        }
        // Small delay between emails to stay within Resend rate limits
        await new Promise(r => setTimeout(r, 120));
      } catch (emailErr) {
        results.failed++;
        results.errors.push(`${donorEmail}: ${emailErr.message}`);
        console.error("[BULK STMT] Error for " + donorEmail + ":", emailErr.message);
      }
    }

    console.log("[BULK STMT] Complete - sent:" + results.sent + " skipped:" + results.skipped + " failed:" + results.failed);
    res.json(results);
  } catch (err) {
    console.error("Bulk giving statement error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Arise Giving API running on port ${PORT}`);
});
