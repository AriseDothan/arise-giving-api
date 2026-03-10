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
  "General Fund":  "Offering",
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

// ── GET /admin/subscriptions  (all active, for admin portal) ──
app.get("/admin/subscriptions", async (req, res) => {
  try {
    const stripe = getStripe();
    const subs   = await stripe.subscriptions.list({ status: "active", limit: 100, expand: ["data.customer","data.items.data.price"] });
    const result = subs.data.map(sub => {
      const item  = sub.items.data[0];
      const price = item?.price;
      const cust  = sub.customer;
      return {
        id:          sub.id,
        donorName:   sub.metadata.donorName  || (typeof cust === "object" ? cust.name  : ""),
        donorEmail:  sub.metadata.donorEmail || (typeof cust === "object" ? cust.email : ""),
        fund:        sub.metadata.fund       || "General Fund",
        amount:      (price?.unit_amount || 0) / 100,
        giftAmount:  parseFloat(sub.metadata.giftAmount || (price?.unit_amount||0)/100),
        freq:        sub.metadata.freq       || price?.recurring?.interval,
        status:      sub.status,
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

// ── POST /webhook ─────────────────────────────────────────────
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
    console.log("[RECURRING] invoice.subscription: " + invoice.subscription + " | billing_reason: " + invoice.billing_reason + " | invoice.id: " + invoice.id);
    // Only process subscription invoices
    if (invoice.subscription) {
      try {
        // Dedup: Stripe may deliver invoice.payment_succeeded more than once
        console.log("[RECURRING] Checking dedup for invoice: " + invoice.id);
        const { data: dup, error: dupErr } = await supabase
          .from("donations").select("id").ilike("notes", "%" + invoice.id + "%").maybeSingle();
        if (dupErr) console.error("[RECURRING] Dedup query error: " + dupErr.message + " code: " + dupErr.code);
        if (dup) { console.log("[RECURRING] Skipping duplicate invoice: " + invoice.id); }
        else {
          const stripe = getStripe();
          const sub    = await stripe.subscriptions.retrieve(invoice.subscription);
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
app.listen(PORT, () => {
  console.log(`Arise Giving API running on port ${PORT}`);
});
