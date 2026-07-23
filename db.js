import { DatabaseSync } from "node:sqlite";

export const db = new DatabaseSync("./forgelink.db");

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    name TEXT NOT NULL,
    industry TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT 'North America',
    country TEXT NOT NULL DEFAULT '',
    needs TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    region TEXT NOT NULL,
    rating REAL NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL,
    price_per_unit REAL NOT NULL,
    min_order_qty INTEGER NOT NULL DEFAULT 1,
    lead_time_days INTEGER NOT NULL,
    stock_qty INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rfqs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    material_id INTEGER NOT NULL REFERENCES materials(id),
    quantity INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'sent',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Estimated freight transit days between regions (sea/air blended estimate).
export const SHIPPING_DAYS = {
  "North America": { "North America": 3, "South America": 12, "Europe": 10, "Middle East": 14, "Africa": 18, "Asia": 16, "Oceania": 18 },
  "South America": { "North America": 12, "South America": 4, "Europe": 14, "Middle East": 18, "Africa": 16, "Asia": 22, "Oceania": 20 },
  "Europe":        { "North America": 10, "South America": 14, "Europe": 3, "Middle East": 7, "Africa": 9, "Asia": 14, "Oceania": 22 },
  "Middle East":   { "North America": 14, "South America": 18, "Europe": 7, "Middle East": 3, "Africa": 8, "Asia": 10, "Oceania": 16 },
  "Africa":        { "North America": 18, "South America": 16, "Europe": 9, "Middle East": 8, "Africa": 5, "Asia": 15, "Oceania": 20 },
  "Asia":          { "North America": 16, "South America": 22, "Europe": 14, "Middle East": 10, "Africa": 15, "Asia": 4, "Oceania": 10 },
  "Oceania":       { "North America": 18, "South America": 20, "Europe": 22, "Middle East": 16, "Africa": 20, "Asia": 10, "Oceania": 3 },
};

export const REGIONS = Object.keys(SHIPPING_DAYS);

export const CATEGORIES = [
  "Structural Steel", "Aluminum", "Copper & Brass", "Fasteners",
  "Bearings & Power Transmission", "Hydraulics & Pneumatics",
  "Electrical", "Polymers & Composites", "Castings & Forgings", "Tooling",
];

function seed() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM suppliers").get().n;
  if (count > 0) return;

  const suppliers = [
    // [name, country, region, rating, verified, description]
    ["Great Lakes Steel Supply", "USA", "North America", 4.7, 1, "Full-line structural steel distributor serving the Midwest since 1962. Mill-certified stock, same-week processing."],
    ["Monterrey Metales SA", "Mexico", "North America", 4.4, 1, "Steel and aluminum service center with in-house cutting and USMCA-friendly logistics."],
    ["Ruhr Präzisionstechnik GmbH", "Germany", "Europe", 4.9, 1, "Precision bearings, linear motion, and power transmission components. DIN/ISO certified."],
    ["Nordic Alloys AB", "Sweden", "Europe", 4.6, 1, "Specialty aluminum and stainless alloys, EN 10204 3.1 certificates standard."],
    ["Adriatic Castings d.o.o.", "Croatia", "Europe", 4.3, 0, "Sand and investment castings in iron, steel, and bronze. Low minimums, pattern shop on site."],
    ["Shenzhen ElectroSource Co.", "China", "Asia", 4.5, 1, "Industrial electrical components: contactors, drives, cabling, connectors. Large export volume."],
    ["Osaka Seimitsu Kogyo", "Japan", "Asia", 4.8, 1, "High-precision bearings and cutting tools. Aerospace and robotics grade quality."],
    ["Mumbai Fastener Works", "India", "Asia", 4.2, 1, "High-volume bolts, nuts, and custom cold-formed fasteners. ISO 9001, competitive pricing."],
    ["Hanoi Polymer Industries", "Vietnam", "Asia", 4.1, 0, "Engineering plastics: nylon, POM, PTFE, UHMW stock shapes and custom extrusion."],
    ["Gulf Hydraulics FZE", "UAE", "Middle East", 4.4, 1, "Hydraulic cylinders, pumps, valves, and hose assemblies. Fast re-export from Jebel Ali."],
    ["Sao Paulo Forjados Ltda", "Brazil", "South America", 4.3, 1, "Open-die and closed-die forgings, machined-ready. Strong in agricultural and mining sectors."],
    ["Cape Industrial Metals", "South Africa", "Africa", 4.0, 0, "Copper, brass, and specialty metals distributor for Sub-Saharan industry."],
    ["Melbourne Toolworks Pty", "Australia", "Oceania", 4.6, 1, "Cutting tools, tooling systems, and workholding. Local support for APAC."],
    ["Pittsburgh Copper & Brass", "USA", "North America", 4.5, 1, "Non-ferrous specialist: copper bus bar, brass stock, bronze bearings. Century-old mill relationships."],
  ];

  const insSupplier = db.prepare(
    "INSERT INTO suppliers (name, country, region, rating, verified, description) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const supplierIds = {};
  for (const s of suppliers) {
    const info = insSupplier.run(...s);
    supplierIds[s[0]] = Number(info.lastInsertRowid);
  }

  const materials = [
    // [supplier, name, category, spec, unit, price, minOrder, leadDays, stock]
    ["Great Lakes Steel Supply", "A36 Steel Plate 1/2\"", "Structural Steel", "ASTM A36, 48x96 sheet, mill cert", "sheet", 385, 5, 7, 240],
    ["Great Lakes Steel Supply", "W8x31 Wide Flange Beam", "Structural Steel", "ASTM A992, 40 ft lengths", "length", 610, 2, 10, 85],
    ["Great Lakes Steel Supply", "A500 Square Tube 2x2x1/4", "Structural Steel", "ASTM A500 Gr B, 24 ft", "length", 96, 10, 7, 400],
    ["Great Lakes Steel Supply", "4140 Alloy Round Bar 2\"", "Structural Steel", "AISI 4140 HT, 12 ft bars", "bar", 210, 5, 12, 120],
    ["Monterrey Metales SA", "A36 Steel Plate 1/2\"", "Structural Steel", "ASTM A36, 48x96 sheet", "sheet", 342, 10, 12, 500],
    ["Monterrey Metales SA", "6061-T6 Aluminum Plate 1/4\"", "Aluminum", "AMS-QQ-A-250/11, 48x96", "sheet", 298, 5, 9, 210],
    ["Monterrey Metales SA", "Galvanized C-Channel 6\"", "Structural Steel", "ASTM A653 G90, 20 ft", "length", 74, 20, 10, 650],
    ["Nordic Alloys AB", "6061-T6 Aluminum Plate 1/4\"", "Aluminum", "EN AW-6061, 3.1 cert, 1250x2500mm", "sheet", 315, 5, 8, 180],
    ["Nordic Alloys AB", "7075-T651 Aluminum Plate 1/2\"", "Aluminum", "AMS 4045, aerospace grade", "sheet", 890, 2, 14, 60],
    ["Nordic Alloys AB", "316L Stainless Round Bar 25mm", "Structural Steel", "EN 1.4404, 3m bars", "bar", 145, 10, 8, 300],
    ["Ruhr Präzisionstechnik GmbH", "Deep Groove Ball Bearing 6205-2RS", "Bearings & Power Transmission", "DIN 625, sealed, C3 clearance", "unit", 4.8, 100, 5, 12000],
    ["Ruhr Präzisionstechnik GmbH", "Spherical Roller Bearing 22220", "Bearings & Power Transmission", "DIN 635, brass cage", "unit", 148, 10, 9, 450],
    ["Ruhr Präzisionstechnik GmbH", "HGR20 Linear Guide Rail + Block", "Bearings & Power Transmission", "20mm profile rail, 1m, preload Z1", "set", 92, 10, 12, 800],
    ["Ruhr Präzisionstechnik GmbH", "Timing Belt HTD 8M 30mm", "Bearings & Power Transmission", "Glass-fiber reinforced neoprene", "meter", 11.5, 50, 6, 5000],
    ["Osaka Seimitsu Kogyo", "Deep Groove Ball Bearing 6205-2RS", "Bearings & Power Transmission", "JIS B 1521, P5 precision, sealed", "unit", 6.9, 100, 8, 8000],
    ["Osaka Seimitsu Kogyo", "Angular Contact Bearing 7208 P4", "Bearings & Power Transmission", "Spindle grade, matched pairs", "pair", 210, 4, 15, 160],
    ["Osaka Seimitsu Kogyo", "Carbide End Mill 12mm 4-Flute", "Tooling", "AlTiN coated, for steel to 45 HRC", "unit", 38, 20, 10, 1500],
    ["Mumbai Fastener Works", "Hex Bolt M12x50 Class 8.8", "Fasteners", "ISO 4014, zinc plated", "100 pcs", 14.5, 10, 14, 9000],
    ["Mumbai Fastener Works", "Hex Bolt M12x50 Class 10.9", "Fasteners", "ISO 4014, plain finish", "100 pcs", 21, 10, 14, 6000],
    ["Mumbai Fastener Works", "Nylock Nut M12", "Fasteners", "ISO 10511, zinc plated", "100 pcs", 6.8, 20, 12, 15000],
    ["Mumbai Fastener Works", "Socket Head Cap Screw M8x30 12.9", "Fasteners", "ISO 4762, black oxide", "100 pcs", 9.2, 20, 12, 11000],
    ["Shenzhen ElectroSource Co.", "3-Phase Contactor 40A", "Electrical", "AC-3 duty, 220V coil, IEC 60947", "unit", 18.5, 20, 12, 3000],
    ["Shenzhen ElectroSource Co.", "VFD 5.5kW 380V", "Electrical", "Vector control, IP20, CE marked", "unit", 245, 5, 15, 320],
    ["Shenzhen ElectroSource Co.", "Control Cable 16x1.5mm2", "Electrical", "Flexible PVC, 300/500V", "100m reel", 128, 5, 10, 700],
    ["Hanoi Polymer Industries", "Nylon 6 Rod 50mm", "Polymers & Composites", "Extruded PA6, natural, 1m lengths", "rod", 21, 25, 11, 2200],
    ["Hanoi Polymer Industries", "PTFE Sheet 10mm", "Polymers & Composites", "Virgin PTFE, 600x600mm", "sheet", 68, 10, 13, 400],
    ["Hanoi Polymer Industries", "UHMW-PE Sheet 20mm", "Polymers & Composites", "1000x2000mm, natural white", "sheet", 105, 8, 13, 260],
    ["Gulf Hydraulics FZE", "Hydraulic Cylinder 63/35x400", "Hydraulics & Pneumatics", "Double acting, 210 bar, ISO 6020", "unit", 310, 2, 12, 140],
    ["Gulf Hydraulics FZE", "Gear Pump 11cc Group 2", "Hydraulics & Pneumatics", "250 bar, EU flange, SAE ports", "unit", 96, 5, 9, 380],
    ["Gulf Hydraulics FZE", "Hydraulic Hose 1/2\" 2SN Assembly", "Hydraulics & Pneumatics", "EN 853 2SN, crimped ends to spec", "unit", 24, 20, 8, 2000],
    ["Sao Paulo Forjados Ltda", "Forged Flange DN100 PN16", "Castings & Forgings", "EN 1092-1, S235, machined", "unit", 34, 20, 16, 900],
    ["Sao Paulo Forjados Ltda", "Forged Shaft Blank 100x800mm", "Castings & Forgings", "AISI 1045, normalized, proof machined", "unit", 265, 4, 20, 70],
    ["Adriatic Castings d.o.o.", "Grey Iron Casting (custom, per kg)", "Castings & Forgings", "EN-GJL-250, sand cast, per drawing", "kg", 3.4, 200, 25, 0],
    ["Adriatic Castings d.o.o.", "Bronze Bushing Casting CuSn12", "Castings & Forgings", "Continuous cast, machining allowance", "kg", 14.8, 50, 18, 800],
    ["Cape Industrial Metals", "Copper Bus Bar 100x10mm", "Copper & Brass", "Cu-ETP, 4m lengths", "length", 168, 5, 10, 220],
    ["Cape Industrial Metals", "Brass Hex Bar 22mm", "Copper & Brass", "CW614N, 3m lengths", "bar", 41, 10, 9, 480],
    ["Pittsburgh Copper & Brass", "Copper Bus Bar 100x10mm", "Copper & Brass", "C11000 ETP, 12 ft lengths", "length", 182, 3, 6, 160],
    ["Pittsburgh Copper & Brass", "Bronze Bearing Stock C932 2\" OD", "Copper & Brass", "SAE 660, cored, 13 in lengths", "bar", 58, 5, 7, 350],
    ["Pittsburgh Copper & Brass", "Brass Sheet C260 0.062\"", "Copper & Brass", "Half hard, 24x96", "sheet", 210, 3, 8, 90],
    ["Melbourne Toolworks Pty", "Carbide End Mill 12mm 4-Flute", "Tooling", "TiAlN, general purpose", "unit", 44, 10, 6, 900],
    ["Melbourne Toolworks Pty", "CNC Vise 6\" Precision", "Tooling", "0.0004\" repeatability, hardened", "unit", 385, 1, 9, 45],
    ["Melbourne Toolworks Pty", "Indexable Turning Insert CNMG 432", "Tooling", "Coated carbide, steel grade, box of 10", "box", 52, 5, 7, 700],
  ];

  const insMaterial = db.prepare(
    "INSERT INTO materials (supplier_id, name, category, spec, unit, price_per_unit, min_order_qty, lead_time_days, stock_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const [supplierName, ...rest] of materials) {
    insMaterial.run(supplierIds[supplierName], ...rest);
  }
}

seed();
