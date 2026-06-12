require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

const toPositiveInt = (value, fallback, max = null) => {
  const parsed = parseInt(value, 10);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return max ? Math.min(safe, max) : safe;
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

const WooCommerce = new WooCommerceRestApi({
  url: process.env.WOOCOMMERCE_URL,
  consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
  consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
  version: "wc/v3",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    success: true,
    message: "Middleware Rentman + WooCommerce + Supabase attivo",
  });
});

// -----------------------------------------------------------------------------
// WOOCOMMERCE
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
// CATALOGO OPERATIVO SUPABASE
// Temporaneamente pubblico per import iniziale.
// Dopo l'import lo richiudiamo con checkApiKey.
// -----------------------------------------------------------------------------
app.get("/catalog/sync-woocommerce", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        error: "Supabase non configurato",
      });
    }

    const perPage = toPositiveInt(req.query.per_page, 100, 100);
    let page = toPositiveInt(req.query.page, 1);
    const maxPages = toPositiveInt(req.query.max_pages, 100, 300);

    let totalImported = 0;
    const imported = [];

    while (page <= maxPages) {
      const wooResponse = await WooCommerce.get("products", {
        per_page: perPage,
        page,
      });

      const products = wooResponse.data || [];

      if (!products.length) {
        break;
      }

      for (const product of products) {
        const payload = {
          woo_product_id: product.id,
          sku: product.sku || null,
          name: product.name,
          category: categoriesToString(product.categories),
          daily_price: parsePrice(product.price),
          image_url: product.images?.[0]?.src || null,
          active: product.status === "publish",
        };

        const { data, error } = await supabase
          .from("catalog_products")
          .upsert(payload, { onConflict: "woo_product_id" })
          .select()
          .single();

        if (error) {
          throw error;
        }

        imported.push(data);
        totalImported += 1;
      }

      if (products.length < perPage) {
        break;
      }

      page += 1;
    }

    res.json({
      success: true,
      message: "Catalogo WooCommerce sincronizzato su Supabase",
      imported_count: totalImported,
      data: imported,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore sincronizzazione catalogo WooCommerce -> Supabase",
      details: error.message || error,
    });
  }
});

app.post("/catalog/sync-woocommerce", checkApiKey, async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        success: false,
        error: "Supabase non configurato",
      });
    }

    const perPage = toPositiveInt(req.body.per_page, 100, 100);
    let page = toPositiveInt(req.body.page, 1);
    const maxPages = toPositiveInt(req.body.max_pages, 100, 300);

    let totalImported = 0;
    const imported = [];

    while (page <= maxPages) {
      const wooResponse = await WooCommerce.get("products", {
        per_page: perPage,
        page,
      });

      const products = wooResponse.data || [];

      if (!products.length) {
        break;
      }

      for (const product of products) {
        const payload = {
          woo_product_id: product.id,
          sku: product.sku || null,
          name: product.name,
          category: categoriesToString(product.categories),
          daily_price: parsePrice(product.price),
          image_url: product.images?.[0]?.src || null,
          active: product.status === "publish",
        };

        const { data, error } = await supabase
          .from("catalog_products")
          .upsert(payload, { onConflict: "woo_product_id" })
          .select()
          .single();

        if (error) {
          throw error;
        }

        imported.push(data);
        totalImported += 1;
      }

      if (products.length < perPage) {
        break;
      }

      page += 1;
    }

    res.json({
      success: true,
      message: "Catalogo WooCommerce sincronizzato su Supabase",
      imported_count: totalImported,
      data: imported,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore sincronizzazione catalogo WooCommerce -> Supabase",
      details: error.message || error,
    });
  }
});

app.get("/catalog/products", checkApiKey, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    let query = supabase
      .from("catalog_products")
      .select("*")
      .eq("active", true)
      .order("name", { ascending: true });

    if (q) {
      query = query.ilike("name", `%${q}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura catalogo operativo",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// CLIENTI
// -----------------------------------------------------------------------------
app.post("/clients", checkApiKey, async (req, res) => {
  try {
    const { name, company, email, phone, vat_number, notes } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Campo obbligatorio mancante: name",
      });
    }

    const { data, error } = await supabase
      .from("clients")
      .insert([{ name, company, email, phone, vat_number, notes }])
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ success: true, created: data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore creazione cliente",
      details: error.message || error,
    });
  }
});

app.get("/clients", checkApiKey, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    let query = supabase
      .from("clients")
      .select("*")
      .order("created_at", { ascending: false });

    if (q) {
      query = query.or(`name.ilike.%${q}%,company.ilike.%${q}%,email.ilike.%${q}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura clienti",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// PROGETTI
// -----------------------------------------------------------------------------
app.post("/projects", checkApiKey, async (req, res) => {
  try {
    const { client_id, name, start_date, end_date, status, notes } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Campo obbligatorio mancante: name",
      });
    }

    const { data, error } = await supabase
      .from("projects")
      .insert([
        {
          client_id,
          name,
          start_date,
          end_date,
          status: status || "draft",
          notes,
        },
      ])
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ success: true, created: data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore creazione progetto",
      details: error.message || error,
    });
  }
});

app.get("/projects", checkApiKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("*, clients(*)")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura progetti",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// SERIALI
// -----------------------------------------------------------------------------
app.post("/serial-numbers", checkApiKey, async (req, res) => {
  try {
    const { product_id, serial_code, status, notes } = req.body;

    if (!product_id || !serial_code) {
      return res.status(400).json({
        success: false,
        error: "Campi obbligatori mancanti: product_id e serial_code",
      });
    }

    const { data, error } = await supabase
      .from("serial_numbers")
      .insert([
        {
          product_id,
          serial_code,
          status: status || "available",
          notes,
        },
      ])
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ success: true, created: data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore creazione seriale",
      details: error.message || error,
    });
  }
});

app.get("/serial-numbers", checkApiKey, async (req, res) => {
  try {
    const productId = req.query.product_id || null;

    let query = supabase
      .from("serial_numbers")
      .select("*, catalog_products(*)")
      .order("serial_code", { ascending: true });

    if (productId) {
      query = query.eq("product_id", productId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura seriali",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// PRENOTAZIONI
// -----------------------------------------------------------------------------
app.post("/bookings", checkApiKey, async (req, res) => {
  try {
    const { project_id, serial_id, start_date, end_date, status } = req.body;

    if (!serial_id || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: "Campi obbligatori mancanti: serial_id, start_date, end_date",
      });
    }

    const { data: conflicts, error: conflictError } = await supabase
      .from("bookings")
      .select("*")
      .eq("serial_id", serial_id)
      .neq("status", "cancelled")
      .lt("start_date", end_date)
      .gt("end_date", start_date);

    if (conflictError) {
      throw conflictError;
    }

    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: "Seriale non disponibile nelle date richieste",
        conflicts,
      });
    }

    const { data, error } = await supabase
      .from("bookings")
      .insert([
        {
          project_id,
          serial_id,
          start_date,
          end_date,
          status: status || "reserved",
        },
      ])
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({ success: true, created: data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore creazione prenotazione",
      details: error.message || error,
    });
  }
});

app.get("/bookings", checkApiKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("bookings")
      .select("*, projects(*), serial_numbers(*, catalog_products(*))")
      .order("start_date", { ascending: true });

    if (error) {
      throw error;
    }

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura prenotazioni",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// DISPONIBILITA
// -----------------------------------------------------------------------------
app.post("/availability/check", checkApiKey, async (req, res) => {
  try {
    const { product_id, start_date, end_date } = req.body;

    if (!product_id || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: "Campi obbligatori mancanti: product_id, start_date, end_date",
      });
    }

    const { data: serials, error: serialError } = await supabase
      .from("serial_numbers")
      .select("*, catalog_products(*)")
      .eq("product_id", product_id)
      .eq("status", "available");

    if (serialError) {
      throw serialError;
    }

    const serialIds = serials.map((serial) => serial.id);

    const { data: overlappingBookings, error: bookingError } = await supabase
      .from("bookings")
      .select("*")
      .in("serial_id", serialIds.length ? serialIds : ["00000000-0000-0000-0000-000000000000"])
      .neq("status", "cancelled")
      .lt("start_date", end_date)
      .gt("end_date", start_date);

    if (bookingError) {
      throw bookingError;
    }

    const bookedSerialIds = new Set(
      overlappingBookings.map((booking) => booking.serial_id)
    );

    const availableSerials = serials.filter(
      (serial) => !bookedSerialIds.has(serial.id)
    );

    res.json({
      success: true,
      product_id,
      start_date,
      end_date,
      total_serials: serials.length,
      available_count: availableSerials.length,
      available_serials: availableSerials,
      booked_serial_ids: Array.from(bookedSerialIds),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore controllo disponibilità",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// PREVENTIVI
// -----------------------------------------------------------------------------
app.post("/quotes", checkApiKey, async (req, res) => {
  try {
    const { client_id, notes, items = [] } = req.body;

    const quoteNumber = `Q-${Date.now()}`;

    let subtotal = 0;

    const quoteItems = items.map((item) => {
      const quantity = Number(item.quantity || 1);
      const unitPrice = Number(item.unit_price || 0);
      const totalPrice = quantity * unitPrice;

      subtotal += totalPrice;

      return {
        product_id: item.product_id || null,
        description: item.description,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
      };
    });

    const vat = subtotal * 0.22;
    const total = subtotal + vat;

    const { data: quote, error: quoteError } = await supabase
      .from("quotes")
      .insert([
        {
          quote_number: quoteNumber,
          client_id,
          status: "draft",
          subtotal,
          vat,
          total,
          notes,
        },
      ])
      .select()
      .single();

    if (quoteError) {
      throw quoteError;
    }

    let insertedItems = [];

    if (quoteItems.length > 0) {
      const rows = quoteItems.map((item) => ({
        ...item,
        quote_id: quote.id,
      }));

      const { data, error } = await supabase
        .from("quote_items")
        .insert(rows)
        .select();

      if (error) {
        throw error;
      }

      insertedItems = data;
    }

    res.json({
      success: true,
      created: quote,
      items: insertedItems,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore creazione preventivo",
      details: error.message || error,
    });
  }
});

app.get("/quotes", checkApiKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("quotes")
      .select("*, clients(*)")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura preventivi",
      details: error.message || error,
    });
  }
});

app.get("/quotes/:id", checkApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: quote, error: quoteError } = await supabase
      .from("quotes")
      .select("*, clients(*)")
      .eq("id", id)
      .single();

    if (quoteError) {
      throw quoteError;
    }

    const { data: items, error: itemsError } = await supabase
      .from("quote_items")
      .select("*, catalog_products(*)")
      .eq("quote_id", id);

    if (itemsError) {
      throw itemsError;
    }

    res.json({
      success: true,
      data: {
        ...quote,
        items,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura preventivo",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// RENTMAN - ENDPOINT ESISTENTI
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

      if (items.length < pageSize) {
        break;
      }

      if (typeof total === "number" && allItems.length >= total) {
        break;
      }

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

    const payload = { name, itemtype };

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
// STOCK / QUANTITA CATALOGO
// -----------------------------------------------------------------------------
app.put("/catalog/products/:id/stock", checkApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      stock_quantity,
      available_quantity,
      stock_type = "quantity",
    } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Parametro obbligatorio mancante: id prodotto",
      });
    }

    if (stock_quantity === undefined || stock_quantity === null) {
      return res.status(400).json({
        success: false,
        error: "Campo obbligatorio mancante: stock_quantity",
      });
    }

    const stockQuantity = Number(stock_quantity);

    if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
      return res.status(400).json({
        success: false,
        error: "stock_quantity deve essere un numero intero maggiore o uguale a 0",
      });
    }

    const availableQuantity =
      available_quantity === undefined || available_quantity === null
        ? stockQuantity
        : Number(available_quantity);

    if (!Number.isInteger(availableQuantity) || availableQuantity < 0) {
      return res.status(400).json({
        success: false,
        error: "available_quantity deve essere un numero intero maggiore o uguale a 0",
      });
    }

    if (!["quantity", "serial"].includes(stock_type)) {
      return res.status(400).json({
        success: false,
        error: "stock_type deve essere 'quantity' oppure 'serial'",
      });
    }

    const { data, error } = await supabase
      .from("catalog_products")
      .update({
        stock_quantity: stockQuantity,
        available_quantity: availableQuantity,
        stock_type,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      message: "Quantità prodotto aggiornata",
      updated: data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore aggiornamento quantità prodotto",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// TEST RAPIDO AGGIORNAMENTO STOCK DA BROWSER
// -----------------------------------------------------------------------------
app.get("/catalog/set-stock", async (req, res) => {
  try {
    const { id, qty, type = "quantity" } = req.query;

    if (!id || qty === undefined) {
      return res.status(400).json({
        success: false,
        error: "Parametri obbligatori mancanti: id e qty",
      });
    }

    const stockQuantity = Number(qty);

    if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
      return res.status(400).json({
        success: false,
        error: "qty deve essere un numero intero maggiore o uguale a 0",
      });
    }

    if (!["quantity", "serial"].includes(type)) {
      return res.status(400).json({
        success: false,
        error: "type deve essere quantity oppure serial",
      });
    }

const { data: oldProduct, error: oldError } = await supabase
  .from("catalog_products")
  .select("*")
  .eq("id", id)
  .single();

if (oldError) throw oldError;

const { data, error } = await supabase
  .from("catalog_products")
  .update({
    stock_quantity: stockQuantity,
    available_quantity: stockQuantity,
    stock_type: type,
  })
  .eq("id", id)
  .select()
  .single();

if (error) throw error;

await supabase.from("activity_log").insert([
  {
    action: "stock_update",
    entity_type: "product",
    entity_id: id,
    product_id: id,
    product_name: data.name,
    old_value: String(oldProduct.stock_quantity),
    new_value: String(stockQuantity),
    user_name: "Dave",
    source: "ChatGPT",
    notes: `Stock aggiornato da ${oldProduct.stock_quantity} a ${stockQuantity}`,
  },
]);

res.json({
  success: true,
  message: "Stock aggiornato correttamente",
  updated: data,
  logged: true,
});
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore aggiornamento stock",
      details: error.message || error,
    });
  }
});

// -----------------------------------------------------------------------------
// ACTIVITY LOG
// -----------------------------------------------------------------------------
app.get("/activity-log", checkApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const productId = req.query.product_id || null;
    const action = req.query.action || null;

    let query = supabase
      .from("activity_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (productId) {
      query = query.eq("product_id", productId);
    }

    if (action) {
      query = query.eq("action", action);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura activity log",
      details: error.message || error,
    });
  }
});
// -----------------------------------------------------------------------------
// ACTIVITY SUMMARY / REPORT OPERATIVI
// -----------------------------------------------------------------------------
app.get("/activity-summary", checkApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);

    const { data, error } = await supabase
      .from("activity_summary")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore lettura activity summary",
      details: error.message || error,
    });
  }
});

app.post("/activity-summary", checkApiKey, async (req, res) => {
  try {
    const {
      period_start,
      period_end,
      title,
      summary,
      source = "ChatGPT",
      created_by = "Dave",
    } = req.body;

    if (!title || !summary) {
      return res.status(400).json({
        success: false,
        error: "Campi obbligatori mancanti: title e summary",
      });
    }

    const { data, error } = await supabase
      .from("activity_summary")
      .insert([
        {
          period_start,
          period_end,
          title,
          summary,
          source,
          created_by,
        },
      ])
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Report attività salvato",
      created: data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Errore creazione activity summary",
      details: error.message || error,
    });
  }
});
app.listen(PORT, () => {
  console.log("Middleware Rentman + WooCommerce + Supabase attivo su porta", PORT);
});
