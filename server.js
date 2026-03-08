// ─────────────────────────────────────────────────────────────
//  Arise Dothan — Giving Backend
//  Handles Stripe payment intents + Supabase donation records
// ─────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const Stripe  = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// Initialize Stripe lazily so the env var is read at request time,
// not at module load time (avoids "no API key" errors on Render)
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
// Raw body MUST come before express.json() — required for Stripe webhook verification
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

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Arise Dothan Giving API" });
});

// ── POST /create-payment-intent ───────────────────────────────
// `amount`     = total charged to donor's card (includes fee coverage if opted in)
// `giftAmount` = the actual donation to record in Supabase (what church receives)
// `coverFees`  = boolean flag from the frontend
app.post("/create-payment-intent", async (req, res) => {
  try {
    const {
      amount,       // total charge to card (dollars)
      giftAmount,   // donor's intended gift (dollars) — may differ if fees covered
      fund,
      donorName,
      donorEmail,
      freq,
      coverFees,
    } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!donorName || !donorEmail) {
      return res.status(400).json({ error: "Donor name and email required" });
    }

    // Stripe always receives the TOTAL (card charge) in cents
    const chargeCents = Math.round(parseFloat(amount) * 100);

    // The gift amount is what goes into financial records
    const recordedGift = giftAmount
      ? parseFloat(giftAmount)
      : parseFloat(amount);

    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount:        chargeCents,
      currency:      "usd",
      receipt_email: donorEmail,
      description:   `${fund || "General Fund"} — Arise Dothan`,
      metadata: {
        donorName,
        donorEmail,
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

// ── POST /webhook ─────────────────────────────────────────────
// Stripe calls this after payment is confirmed.
// We record giftAmount (not the raw charge) in Supabase so the
// financial dashboard always shows what the church actually received.
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    const { donorName, donorEmail, fund, freq, giftAmount, coverFees } = pi.metadata;

    // Use giftAmount from metadata — this is what the church receives.
    // If donor covered fees: Stripe's cut comes out of the extra they added.
    const recordedAmount = giftAmount
      ? parseFloat(giftAmount)
      : pi.amount / 100;

    const today     = new Date().toISOString().split("T")[0];
    const freqLabel = freq === "one-time" ? "One-Time"
                    : freq.charAt(0).toUpperCase() + freq.slice(1);
    const feeNote   = coverFees === "true" ? " · Donor covered fees" : "";

    try {
      // 1. Upsert donor record
      const nameParts = (donorName || "").trim().split(" ");
      const firstName = nameParts[0] || "";
      const lastName  = nameParts.slice(1).join(" ") || "";

      const { data: existing } = await supabase
        .from("donors")
        .select("id")
        .eq("first_name", firstName)
        .eq("last_name", lastName)
        .maybeSingle();

      if (!existing) {
        await supabase.from("donors").insert({
          first_name: firstName,
          last_name:  lastName,
          email:      donorEmail || "",
        });
      }

      // 2. Record donation using GIFT amount (not the card charge)
      const { error } = await supabase.from("donations").insert({
        date:   today,
        donor:  donorName,
        type:   FUND_TYPE_MAP[fund] || "Offering",
        amount: recordedAmount,
        notes:  `${fund} · ${freqLabel}${feeNote} · Stripe ${pi.id}`,
      });

      if (error) {
        console.error("Supabase insert error:", error.message);
      } else {
        console.log(
          `✅ Donation recorded: ${donorName} — gift $${recordedAmount}` +
          (coverFees === "true" ? ` (donor covered fees, charged $${pi.amount / 100})` : "") +
          ` → ${fund}`
        );
      }

    } catch (err) {
      console.error("Supabase error:", err.message);
    }
  }

  res.json({ received: true });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Arise Giving API running on port ${PORT}`);
});
