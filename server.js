require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const WooCommerceRestApi =
  require("@woocommerce/woocommerce-rest-api").default;

const app = express();

app.use(cors());
app.use(express.json());

// ==========================
// RENTMAN
// ==========================

const rentman = axios.create({
  baseURL: "https://api.rentman.net",
  headers: {
    Authorization: `Bearer ${process.env.RENTMAN_API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// ==========================
// WOOCOMMERCE
// ==========================

const WooCommerce = new WooCommerceRestApi({
  url: process.env.WOOCOMMERCE_URL,
  consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
  consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
  version: "wc/v3",
});

// ==========================
// HEALTH CHECK
// ==========================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Middleware Rentman + WooCommerce attivo",
  });
});

// ==========================
// GET EQUIPMENT
// ==========================

app.get("/equipment", async (req, res) => {
  try {
    const response = await rentman.get("/equipment", {
      params: {
        limit: req.query.limit || 50,
        offset: req.query.offset || 0,
      },
    });

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Errore lettura prodotti Rentman",
      details: error.response?.data || error.message,
    });
  }
});

// ==========================
// CREATE EQUIPMENT
// ==========================

app.post("/equipment", async (req, res) => {
  try {
    const response = await rentman.post("/equipment", req.body);

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Errore creazione prodotto",
      details: error.response?.data || error.message,
    });
  }
});

// ==========================
// GET CONTACTS
// ==========================

app.get("/contacts", async (req, res) => {
  try {
    const response = await rentman.get("/contacts", {
      params: {
        limit: req.query.limit || 50,
        offset: req.query.offset || 0,
      },
    });

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Errore lettura contatti",
      details: error.response?.data || error.message,
    });
  }
});

// ==========================
// GET PROJECTS
// ==========================

app.get("/projects", async (req, res) => {
  try {
    const response = await rentman.get("/projects", {
      params: {
        limit: req.query.limit || 50,
        offset: req.query.offset || 0,
      },
    });

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Errore lettura progetti",
      details: error.response?.data || error.message,
    });
  }
});

// ==========================
// WOOCOMMERCE PRODUCTS
// ==========================

app.get("/woocommerce-products", async (req, res) => {
  try {
    const response = await WooCommerce.get("products", {
      per_page: 20,
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: "Errore WooCommerce",
      details: error.response?.data || error.message,
    });
  }
});

// ==========================
// IMPORT WOOCOMMERCE → RENTMAN
// ==========================

app.post("/import-woocommerce-products", async (req, res) => {
  try {
    const products = await WooCommerce.get("products", {
      per_page: 20,
    });

    const imported = [];

    for (const product of products.data) {
      try {
        const created = await rentman.post("/equipment", {
          name: product.name,
          code: product.sku || `WC-${product.id}`,
          internal_remark: product.short_description || "",
        });

        imported.push({
          woo_product: product.name,
          rentman_id: created.data.data?.[0]?.id || created.data.id,
        });
      } catch (err) {
        imported.push({
          woo_product: product.name,
          error: err.response?.data || err.message,
        });
      }
    }

    res.json({
      success: true,
      imported,
    });
  } catch (error) {
    res.status(500).json({
      error: "Errore import WooCommerce → Rentman",
      details: error.response?.data || error.message,
    });
  }
});

// ==========================
// START SERVER
// ==========================

app.listen(process.env.PORT || 3000, () => {
  console.log(
    "Middleware Rentman + WooCommerce attivo su porta",
    process.env.PORT || 3000
  );
});