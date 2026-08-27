const express = require("express");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL。请连接 PostgreSQL 数据库。");
  process.exit(1);
}

app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...(process.env.DATABASE_SSL === "true"
    ? { ssl: { rejectUnauthorized: false } }
    : {})
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "操作过于频繁，请稍后再试。" }
});

function normalizeCode(v) {
  return String(v || "").trim().toUpperCase();
}
function validDeviceCode(code) {
  return /^[A-Z0-9_-]{1,32}$/.test(code);
}
function cleanRemark(v) {
  return String(v || "").trim().slice(0, 200);
}
function baseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || `${req.protocol}://${req.get("host")}`;
}
function csvEscape(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id BIGSERIAL PRIMARY KEY,
        code VARCHAR(32) NOT NULL UNIQUE,
        name VARCHAR(120) NOT NULL,
        location VARCHAR(160) NOT NULL DEFAULT '',
        oil_unit VARCHAR(12) NOT NULL DEFAULT 'L',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS lubrication_records (
        id BIGSERIAL PRIMARY KEY,
        device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
        remark VARCHAR(200) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lubrication_records_device_time
      ON lubrication_records(device_id, created_at DESC);
    `);

    const seeds = [
  ["SB001", "电力测功器", "试车一线"],
  ["SB002", "辅助支撑", "试车一线"],
  ["SB003", "液压站", "试车一线"]
];

for (const [code, name, location] of seeds) {
  await client.query(
    `INSERT INTO devices(code, name, location)
     VALUES($1,$2,$3)
     ON CONFLICT(code) DO UPDATE SET
       name = EXCLUDED.name,
       location = EXCLUDED.location`,
    [code, name, location]
  );
}

    const count = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM lubrication_records r
       JOIN devices d ON d.id=r.device_id
       WHERE d.code='SB001'`
    );
    if (count.rows[0].n === 0) {
      await client.query(`
        INSERT INTO lubrication_records(device_id, amount, remark, created_at)
        SELECT id, 2.5, '正常加注', NOW() - INTERVAL '22 hours'
        FROM devices WHERE code='SB001'
      `);
      await client.query(`
        INSERT INTO lubrication_records(device_id, amount, remark, created_at)
        SELECT id, 3.0, '', NOW() - INTERVAL '7 days'
        FROM devices WHERE code='SB001'
      `);
      await client.query(`
        INSERT INTO lubrication_records(device_id, amount, remark, created_at)
        SELECT id, 2.8, '例行保养', NOW() - INTERVAL '12 days'
        FROM devices WHERE code='SB001'
      `);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/devices", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await pool.query(`
      SELECT d.code, d.name, d.location, d.oil_unit,
             lr.amount::float8 AS last_amount, lr.created_at AS last_time
      FROM devices d
      LEFT JOIN LATERAL (
        SELECT amount, created_at
        FROM lubrication_records
        WHERE device_id=d.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) lr ON TRUE
      WHERE d.active=TRUE
      ORDER BY d.code
    `);
    res.json({ devices: rows });
  } catch (e) { next(e); }
});

app.get("/api/device/:code", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const code = normalizeCode(req.params.code);
    if (!validDeviceCode(code)) return res.status(400).json({ error: "设备编号格式错误。" });

    const deviceResult = await pool.query(
      `SELECT id, code, name, location, oil_unit
       FROM devices WHERE code=$1 AND active=TRUE`,
      [code]
    );
    if (!deviceResult.rowCount) return res.status(404).json({ error: "未找到该设备。" });

    const device = deviceResult.rows[0];
    const history = await pool.query(
      `SELECT id, amount::float8 AS amount, remark, created_at
       FROM lubrication_records
       WHERE device_id=$1
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [device.id]
    );

    res.json({
      device: {
        code: device.code,
        name: device.name,
        location: device.location,
        oilUnit: device.oil_unit
      },
      last: history.rows[0] || null,
      history: history.rows
    });
  } catch (e) { next(e); }
});

app.post("/api/device/:code/records", writeLimiter, async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!validDeviceCode(code)) return res.status(400).json({ error: "设备编号格式错误。" });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: "请输入正确的加注量。" });
    }
    const remark = cleanRemark(req.body.remark);

    const result = await pool.query(
      `INSERT INTO lubrication_records(device_id, amount, remark)
       SELECT id, $2, $3
       FROM devices
       WHERE code=$1 AND active=TRUE
       RETURNING id, amount::float8 AS amount, remark, created_at`,
      [code, amount, remark]
    );
    if (!result.rowCount) return res.status(404).json({ error: "未找到该设备。" });

    res.status(201).json({ ok: true, record: result.rows[0] });
  } catch (e) { next(e); }
});

app.get("/api/device/:code/history.csv", async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!validDeviceCode(code)) return res.status(400).send("设备编号格式错误");

    const result = await pool.query(
      `SELECT d.code, d.name, r.created_at, r.amount::float8 AS amount, r.remark
       FROM devices d
       JOIN lubrication_records r ON r.device_id=d.id
       WHERE d.code=$1 AND d.active=TRUE
       ORDER BY r.created_at DESC, r.id DESC`,
      [code]
    );
    if (!result.rowCount) {
      const exists = await pool.query(`SELECT 1 FROM devices WHERE code=$1 AND active=TRUE`, [code]);
      if (!exists.rowCount) return res.status(404).send("未找到该设备");
    }

    const lines = [
      ["设备编号","设备名称","加注时间","加注量(L)","备注"],
      ...result.rows.map(r => [r.code, r.name, new Date(r.created_at).toISOString(), r.amount, r.remark])
    ].map(row => row.map(csvEscape).join(","));

    const filename = `${code}_lubrication.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\ufeff" + lines.join("\r\n"));
  } catch (e) { next(e); }
});

app.get("/api/device/:code/qr.svg", async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!validDeviceCode(code)) return res.status(400).send("设备编号格式错误");

    const exists = await pool.query(`SELECT 1 FROM devices WHERE code=$1 AND active=TRUE`, [code]);
    if (!exists.rowCount) return res.status(404).send("未找到该设备");

    const url = `${baseUrl(req)}/e/${encodeURIComponent(code)}`;
    const svg = await QRCode.toString(url, {
      type: "svg",
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M"
    });
    res.type("image/svg+xml").send(svg);
  } catch (e) { next(e); }
});

app.get("/qr/:code", async (req, res, next) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!validDeviceCode(code)) return res.status(400).send("设备编号格式错误");

    const result = await pool.query(
      `SELECT code, name, location FROM devices WHERE code=$1 AND active=TRUE`,
      [code]
    );
    if (!result.rowCount) return res.status(404).send("未找到该设备");

    const d = result.rows[0];
    const target = `${baseUrl(req)}/e/${encodeURIComponent(code)}`;
    res.type("html").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(d.code)} 二维码</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:#f6f7fb;color:#111827}
.wrap{max-width:560px;margin:30px auto;padding:22px}.card{background:#fff;border-radius:20px;padding:28px;text-align:center;box-shadow:0 10px 30px #00000012}
img{width:min(78vw,360px);height:auto}.code{font-size:24px;font-weight:800;margin-top:14px}.name{font-size:18px;margin:5px}.loc{color:#64748b}.url{font-size:12px;word-break:break-all;color:#475569;margin-top:18px}
button{margin-top:18px;border:0;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer}
@media print{button{display:none}.card{box-shadow:none}.wrap{margin:0}}
</style></head><body><main class="wrap"><section class="card">
<img src="/api/device/${encodeURIComponent(code)}/qr.svg" alt="设备二维码">
<div class="code">${escapeHtml(d.code)}</div>
<div class="name">${escapeHtml(d.name)}</div>
<div class="loc">${escapeHtml(d.location)}</div>
<div class="url">${escapeHtml(target)}</div>
<button onclick="window.print()">打印二维码</button>
</section></main></body></html>`);
  } catch (e) { next(e); }
});

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  })[ch]);
}

app.get("/e/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith("/api/")) {
    res.status(500).json({ error: "服务器处理失败，请稍后重试。" });
  } else {
    res.status(500).send("服务器处理失败");
  }
});

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Lubrication app listening on 0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("数据库初始化失败：", err);
    process.exit(1);
  });
