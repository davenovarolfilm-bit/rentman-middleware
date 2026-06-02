require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// -----------------------------------------------------------------------------
// SECURITY
// -----------------------------------------------------------------------------
const checkApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];

  if (!process.env.MIDDLEWARE_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "MIDDLEWARE_API_KEY non configurata",
    });
  }

  if (apiKey !== process.env.MIDDLEWARE_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Accesso non autorizzato",
    });
  }

  next();
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
const getAxiosError = (error) => ({
  status: error.response?.status || 500,
  details: error.response?.data || error.message,
});

const cleanHtml = (html = "") => {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
};

const parsePrice = (value) => {
  const parsed = parseFloat(value || 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const categoriesToString = (categories = []) => {
  return categories.map((cat) => cat.name).filter(Boolean).join(", ");
};

const getRentmanDataArray = (payload) => {
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.data && typeof payload.data === "object") return [payload.data];
  if (Array.isArray(payload)) return payload;
  return [];
};

const getFirstRentmanItem = (payload) => {
  const arr = getRentmanDataArray(payload);
  return arr[0] || payload?.data || payload || null;
};

const toPositiveInt = (value, fallback, max = null) => {
  const parsed = parseInt(value, 10);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return max ? Math.min(safe, max) : safe;
};

const normalizeFileId = (body = {}) => {
  const raw = body.file_id || body.fileId || body.id || body.image;

  if (!raw) return null;

  if (typeof raw === "number") return raw;

  const asString = String(raw).trim();
  const match = asString.match(/(?:\/files\/)?(\d+)$/);

  return match ? parseInt(match[1], 10) : null;
};

// -----------------------------------------------------------------------------
// RENTMAN CLIENT
// -----------------------------------------------------------------------------
const rentman = axios.create({
  baseURL: "https://api.rentman.net",
  headers: {
    Authorization: `Bearer ${process.env.RENTMAN_API_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

rentman.interceptors.request.use((config) => {
  if (!process.env.RENTMAN_API_TOKEN) {
    throw new Error("RENTMAN_API_TOKEN non configurata");
  }

  return config;
});

// -----------------------------------------------------------------------------
// WOOCOMMERCE CLIENT
// -----------------------------------------------------------------------------
const WooCommerce = new WooCommerceRestApi({
  url: process.env.WOOCOMMERCE_URL,
  consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
  consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
  version: "wc/v3",
});

// -----------------------------------------------------------------------------
// HEALTH
// -----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    success: true,
    message: "Middleware Rentman + WooCommerce attivo",
  });
});

// -----------------------------------------------------------------------------
// EQUIPMENT
// -----------------------------------------------------------------------------
app.get("/equipment", checkApiKey, async (req, res) => {
  try {
    const response = await rentman.get("/equipment", {
      params: {
        ...req.query,
        limit: req.query.limit || 50,
        offset: req.query.offset || 0,
      },
    });

    res.json(response.data);
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore lettura attrezzature",
      details: err.details,
    });
  }
});

app.get("/equipment/search", checkApiKey, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();

    if (!q) {
      return res.status(400).json({
        success: false,
        error: "Parametro obbligatorio mancante: q",
      });
    }

    const pageSize = 300;
    const maxScan = toPositiveInt(req.query.max_scan, 3000, 10000);

    let offset = 0;
    let total = null;

    const allItems = [];

    while (offset < maxScan) {
      const response = await rentman.get("/equipment", {
        params: {
          limit: pageSize,
          offset,
          fields:
            req.query.fields ||
            "id,name,displayname,code,folder,image,in_archive,modified",
        },
      });

      const items = getRentmanDataArray(response.data);

      total = response.data?.itemCount ?? total;
      allItems.push(...items);

      if (items.length < pageSize) break;
      if (typeof total === "number" && allItems.length >= total) break;

      offset += pageSize;
    }

    const results = allItems.filter((item) => {
      const haystack = [item.name, item.displayname, item.code]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(q);
    });

    res.json({
      success: true,
      query: req.query.q,
      scanned_count: allItems.length,
      result_count: results.length,
      data: results,
    });
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore ricerca attrezzature",
      details: err.details,
    });
  }
});

app.post("/equipment", checkApiKey, async (req, res) => {
  try {
    const payload = { ...req.body };

    if (!payload.name || !payload.code) {
      return res.status(400).json({
        success: false,
        error: "Campi obbligatori mancanti: name e code",
      });
    }

    const response = await rentman.post("/equipment", payload);

    res.json({
      success: true,
      created: response.data,
    });
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore creazione attrezzatura Rentman",
      details: err.details,
    });
  }
});

app.put("/equipment/:id", checkApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const payload = { ...req.body };

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Parametro obbligatorio mancante: id",
      });
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({
        success: false,
        error: "Body vuoto: indica almeno un campo da aggiornare",
      });
    }

    const response = await rentman.put(`/equipment/${id}`, payload);

    res.json({
      success: true,
      updated: response.data,
    });
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore aggiornamento attrezzatura Rentman",
      details: err.details,
    });
  }
});

// -----------------------------------------------------------------------------
// EQUIPMENT FILES / IMAGES
// -----------------------------------------------------------------------------

// Legge i file gia collegati a un'attrezzatura Rentman.
app.get("/equipment/:id/files", checkApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Parametro obbligatorio mancante: id",
      });
    }

    const response = await rentman.get(`/equipment/${id}/files`, {
      params: {
        ...req.query,
        limit: req.query.limit || 100,
        offset: req.query.offset || 0,
      },
    });

    res.json(response.data);
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore lettura file collegati all'attrezzatura",
      details: err.details,
    });
  }
});

// Imposta come immagine principale dell'attrezzatura un file immagine gia presente in Rentman.
// Body accettati:
// { "file_id": 123 }
// { "image": "/files/123" }
app.post("/equipment/:id/image", checkApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const fileId = normalizeFileId(req.body);

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Parametro obbligatorio mancante: id",
      });
    }

    if (!fileId) {
      return res.status(400).json({
        success: false,
        error:
          'Campo obbligatorio mancante: file_id. Esempio body: { "file_id": 123 } oppure { "image": "/files/123" }',
      });
    }

    const filePath = `/files/${fileId}`;

    const fileResponse = await rentman.get(filePath);
    const file = getFirstRentmanItem(fileResponse.data);

    if (file && file.image === false) {
      return res.status(400).json({
        success: false,
        error: "Il file indicato esiste ma non risulta essere un'immagine",
        file,
      });
    }

    const updateResponse = await rentman.put(`/equipment/${id}`, {
      image: filePath,
    });

    res.json({
      success: true,
      message: "Immagine principale attrezzatura aggiornata",
      equipment_id: Number(id),
      file_id: fileId,
      image: filePath,
      file,
      updated: updateResponse.data,
    });
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore aggiornamento immagine attrezzatura",
      details: err.details,
    });
  }
});

// Rimuove l'immagine principale dell'attrezzatura.
app.delete("/equipment/:id/image", checkApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Parametro obbligatorio mancante: id",
      });
    }

    const response = await rentman.put(`/equipment/${id}`, {
      image: null,
    });

    res.json({
      success: true,
      message: "Immagine principale attrezzatura rimossa",
      equipment_id: Number(id),
      updated: response.data,
    });
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore rimozione immagine attrezzatura",
      details: err.details,
    });
  }
});

// -----------------------------------------------------------------------------
// FOLDERS
// -----------------------------------------------------------------------------
app.get("/folders", checkApiKey, async (req, res) => {
  try {
    const response = await rentman.get("/folders", {
      params: {
        ...req.query,
        limit: req.query.limit || 100,
        offset: req.query.offset || 0,
      },
    });

    res.json(response.data);
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore lettura cartelle Rentman",
      details: err.details,
    });
  }
});

app.post("/folders", checkApiKey, async (req, res) => {
  try {
    const { name, itemtype = "equipment", parent = null } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Campo obbligatorio mancante: name",
      });
    }

    const payload = {
      name,
      itemtype,
    };

    if (parent) {
      payload.parent = parent;
    }

    const response = await rentman.post("/folders", payload);

    res.json({
      success: true,
      created: response.data,
    });
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore creazione cartella Rentman",
      details: err.details,
    });
  }
});

// -----------------------------------------------------------------------------
// WOOCOMMERCE PRODUCTS
// -----------------------------------------------------------------------------
app.get("/woocommerce-products", checkApiKey, async (req, res) => {
  try {
    const response = await WooCommerce.get("products", {
      per_page: req.query.per_page || 20,
      page: req.query.page || 1,
    });

    res.json(response.data);
  } catch (error) {
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore lettura WooCommerce",
      details: err.details,
    });
  }
});

// -----------------------------------------------------------------------------
// IMPORT WOOCOMMERCE -> RENTMAN
// -----------------------------------------------------------------------------
app.post("/import-woocommerce-products", checkApiKey, async (req, res) => {
  try {
    const perPage = req.body.per_page || 20;
    const page = req.body.page || 1;

    const wooResponse = await WooCommerce.get("products", {
      per_page: perPage,
      page,
    });

    const existingResponse = await rentman.get("/equipment", {
      params: {
        limit: 300,
        offset: 0,
        fields: "id,name,displayname,code",
      },
    });

    const existingCodes = new Set(
      getRentmanDataArray(existingResponse.data)
        .map((item) => item.code)
        .filter(Boolean)
    );

    const imported = [];
    const skipped = [];
    const errors = [];

    for (const product of wooResponse.data) {
      const code = product.sku || `WC-${product.id}`;

      if (existingCodes.has(code)) {
        skipped.push({
          woo_id: product.id,
          woo_product: product.name,
          code,
          reason: "Prodotto gia presente in Rentman",
        });
        continue;
      }

      try {
        const categories = categoriesToString(product.categories);
        const description =
          cleanHtml(product.description) || cleanHtml(product.short_description) || "";

        const payload = {
          name: product.name,
          code,
          internal_remark: description,
          external_remark: categories,
          price: parsePrice(product.price),
          list_price: parsePrice(product.regular_price || product.price),
        };

        const created = await rentman.post("/equipment", payload);
        const createdItem = getFirstRentmanItem(created.data);

        imported.push({
          woo_id: product.id,
          woo_product: product.name,
          code,
          categories,
          price: payload.price,
          rentman_id: createdItem?.id || null,
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
    const err = getAxiosError(error);

    res.status(err.status).json({
      success: false,
      error: "Errore import WooCommerce -> Rentman",
      details: err.details,
    });
  }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("Middleware Rentman + WooCommerce attivo su porta", PORT);
});