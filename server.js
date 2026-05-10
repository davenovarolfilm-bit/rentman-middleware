require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const WooCommerceRestApi =
  require("@woocommerce/woocommerce-rest-api").default;

const app = express();

app.use(cors());
app.use(express.json());

// SECURITY
const checkApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];

  if (!process.env.MIDDLEWARE_API_KEY) {
    return res.status(500).json({
      error: "MIDDLEWARE_API_KEY non configurata su Render",
    });
  }

  if (apiKey !== process.env.MIDDLEWARE_API_KEY) {
    return res.status(401).json({
      error: "Accesso non autorizzato",
    });
  }

  next();
};

// HELPERS
const cleanHtml = (html = "") => {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
};

const parsePrice = (value) => {
  const price = parseFloat(value || 0);
  return Number.isNaN(price) ? 0 : price;
};

const namesToString = (items = []) => {
  return items.map((item) => item.name).filter(Boolean).join(", ");
};

// RENTMAN
const rentman = axios.create({
  baseURL: "https://api.rentman.net",
  headers: {
    Authorization: `Bearer ${process.env.RENTMAN_API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// WOOCOMMERCE
const WooCommerce = new WooCommerceRestApi({
  url: process.env.WOOCOMMERCE_URL,
  consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
  consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
  version: "wc/v3",
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Middleware Rentman + WooCommerce attivo",
  });
});

// GET EQUIPMENT
app.get("/equipment", checkApiKey, async (req, res) => {
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

// CREATE EQUIPMENT
app.post("/equipment", checkApiKey, async (req, res) => {
  try {
    const response = await rentman.post("/equipment", req.body);
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Errore creazione prodotto Rentman",
      details: error.response?.data || error.message,
    });
  }
});

// GET CONTACTS
app.get("/contacts", checkApiKey, async (req, res) => {
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
      error: "Errore lettura contatti Rentman",
      details: error.response?.data || error.message,
    });
  }
});

// GET PROJECTS
app.get("/projects", checkApiKey, async (req, res) => {
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
      error: "Errore lettura progetti Rentman",
      details: error.response?.data || error.message,
    });
  }
});

// WOOCOMMERCE PRODUCTS
app.get("/woocommerce-products", checkApiKey, async (req, res) => {
  try {
    const response = await WooCommerce.get("products", {
      per_page: req.query.per_page || 20,
      page: req.query.page || 1,
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: "Errore lettura prodotti WooCommerce",
      details: error.response?.data || error.message,
    });
  }
});

// IMPORT WOOCOMMERCE → RENTMAN
app.post("/import-woocommerce-products", checkApiKey, async (req, res) => {
  try {
    const perPage = req.body.per_page || 20;
    const page = req.body.page || 1;

    const wooResponse = await WooCommerce.get("products", {
      per_page: perPage,
      page,
    });

    const rentmanExisting = await rentman.get("/equipment", {
      params: {
        limit: 300,
        offset: 0,
      },
    });

    const existingCodes = new Set(
      (rentmanExisting.data.data || [])
        .map((item) => item.code)
        .filter(Boolean)
    );

    const imported = [];
    const skipped = [];
    const errors = [];

    for (const product of wooResponse.data) {
      const code = product.sku || `WC-${product.id}`;
      const categories = namesToString(product.categories);

      if (existingCodes.has(code)) {
        skipped.push({
          woo_id: product.id,
          woo_product: product.name,
          code,
          reason: "Prodotto già presente in Rentman",
        });
        continue;
      }

      try {
        const description =
          cleanHtml(product.description) ||
          cleanHtml(product.short_description) ||
          "";

        const payload = {
          name: product.name,
          code,
          internal_remark: description,
          external_remark: categories,
          price: parsePrice(product.price),
          list_price: parsePrice(product.regular_price || product.price),
          type: "item",
          rental_sales: "Rental",
        };

        const created = await rentman.post("/equipment", payload);

        imported.push({
          woo_id: product.id,
          woo_product: product.name,
          code,
          price: payload.price,
          list_price: payload.list_price,
          categories,
          rentman_id: created.data.data?.[0]?.id || created.data.id || null,
          status: "imported",
        });

        existingCodes.add(code);
      } catch (err) {
        errors.push({
          woo_id: product.id,
          woo_product: product.name,
          code,
          error: err.response?.data || err.message,
        });
      }
    }

    res.json({
      success: true,
      requested_page: page,
      per_page: perPage,
      imported_count: imported.length,
      skipped_count: skipped.length,
      error_count: errors.length,
      imported,
      skipped,
      errors,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore import WooCommerce → Rentman",
      details: error.response?.data || error.message,
    });
  }
});

// START SERVER
app.listen(process.env.PORT || 3000, () => {
  console.log(
    "Middleware Rentman + WooCommerce attivo su porta",
    process.env.PORT || 3000
  );
});