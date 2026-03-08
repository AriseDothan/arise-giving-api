// ─────────────────────────────────────────────────────────────
//  Arise Dothan — Giving Backend
//  Handles Stripe payment intents + Supabase donation records
// ─────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  "https://pqgmmvxcxmhpdorvrjfk.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxZ21tdnhjeG1ocGRvcnZyamZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MzM0ODksImV4cCI6MjA4ODUwOTQ4OX0.fu2CWqHUAbt9ykN5sIC4FBV7lVIXECRU1DimYPu0DpI"
);

// ── Middleware ────────────────────────────────────────────────
// Raw body needed for Stripe webhook signature verification
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors({
  origin: [
    "https://arisedothan.com",
    "http://localhost:3000",
    /\.netlify\.app$/,
    /\.render\.com$/
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
// Called by the giving app when donor clicks "Give"
// Returns a clientSecret the frontend uses to confirm payment
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, fund, donorName, donorEmail, freq } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!donorName || !donorEmail) {
      return res.status(400).json({ error: "Donor name and email required" });
    }

    // Amount in cents for Stripe
    const amountCents = Math.round(parseFloat(amount) * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amountCents,
      currency: "usd",
      receipt_email: donorEmail,
      description: `${fund || "General Fund"} — Arise Dothan`,
      metadata: {
        donorName,
        donorEmail,
        fund:  fund  || "General Fund",
        freq:  freq  || "one-time",
        source: "giving-app",
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error("PaymentIntent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook ─────────────────────────────────────────────
// Stripe calls this after a successful payment
// This is where we write the confirmed donation to Supabase
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Only care about successful payments
  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    const { donorName, donorEmail, fund, freq } = pi.metadata;
    const amount = pi.amount / 100; // Convert cents back to dollars
    const today  = new Date().toISOString().split("T")[0];
    const freqLabel = freq === "one-time" ? "One-Time"
                    : freq.charAt(0).toUpperCase() + freq.slice(1);

    try {
      // 1. Upsert donor
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

      // 2. Record donation
      const { error } = await supabase.from("donations").insert({
        date:   today,
        donor:  donorName,
        type:   FUND_TYPE_MAP[fund] || "Offering",
        amount: amount,
        notes:  `${fund} · ${freqLabel} · Stripe ${pi.id}`,
      });

      if (error) console.error("Supabase insert error:", error.message);
      else console.log(`✅ Donation recorded: ${donorName} $${amount} → ${fund}`);

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
