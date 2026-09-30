const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const paperWidth = 226.77; // 80 mm
const padding = 12;
const contentWidth = paperWidth - padding * 2;
const money = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
});
const formatMoney = (value) => money.format(value);

// EN: BillSaleDetail stores one row per unit; group only identical snapshots for display without repricing.
// FI: BillSaleDetail tallentaa rivin annosta kohti; yhdistä vain samat tilannekuvat näyttöä varten hinnoittelematta uudelleen.
const groupReceiptLines = (lines) => {
  const groups = new Map();
  for (const line of lines) {
    const key = JSON.stringify([
      line.foodId,
      line.foodName,
      line.foodSizeId,
      line.foodSizeName,
      line.tastedId,
      line.tasteName,
      line.price,
      line.moneyAdded,
    ]);
    const existing = groups.get(key);
    if (existing) existing.quantity += 1;
    else groups.set(key, { ...line, quantity: 1 });
  }
  return [...groups.values()];
};

const createDocument = (height) => {
  const doc = new PDFDocument({
    size: [paperWidth, height],
    margins: { top: padding, bottom: padding, left: padding, right: padding },
    info: { Title: "Kuitti", Creator: "Ravintola POS" },
  });
  doc.registerFont(
    "receipt",
    path.join(__dirname, "../Kanit/Kanit-Regular.ttf"),
  );
  doc.registerFont(
    "receiptBold",
    path.join(__dirname, "../Kanit/Kanit-Medium.ttf"),
  );
  return doc;
};

// EN: Measure each wrapped text block before drawing so names and modifiers never collide with amounts or totals.
// FI: Mittaa jokainen rivittyvä tekstilohko ennen piirtämistä, jotta nimet ja lisävalinnat eivät osu summiin tai yhteissummaan.
const receiptLayout = (doc, organization, receipt) => {
  const operations = [];
  let y = padding;
  const text = (value, x, width, size = 8, bold = false, align = "left") => {
    const font = bold ? "receiptBold" : "receipt";
    const options = { width, align, lineGap: 1 };
    const height = doc
      .font(font)
      .fontSize(size)
      .heightOfString(String(value), options);
    operations.push({
      type: "text",
      value: String(value),
      x,
      y,
      size,
      font,
      options,
    });
    return height;
  };
  const full = (value, size = 8, bold = false, align = "left") => {
    y += text(value, padding, contentWidth, size, bold, align) + 2;
  };
  const pair = (label, value, size = 8, bold = false) => {
    const valueWidth = 78;
    const labelHeight = text(
      label,
      padding,
      contentWidth - valueWidth - 8,
      size,
      bold,
    );
    const valueHeight = text(
      value,
      paperWidth - padding - valueWidth,
      valueWidth,
      size,
      bold,
      "right",
    );
    y += Math.max(labelHeight, valueHeight) + 2;
  };
  const separator = () => {
    y += 5;
    operations.push({ type: "separator", y });
    y += 7;
  };
  const logoPath =
    organization.logo && path.basename(organization.logo) === organization.logo
      ? path.join("uploads", organization.logo)
      : null;
  if (logoPath && fs.existsSync(logoPath)) {
    operations.push({ type: "logo", path: logoPath, y });
    y += 50;
  }
  full(organization.name, 12, true, "center");
  if (organization.address) full(organization.address, 8, false, "center");
  if (organization.phone)
    full(`Puhelin: ${organization.phone}`, 8, false, "center");
  if (organization.email)
    full(`Sähköposti: ${organization.email}`, 8, false, "center");
  if (organization.taxCode)
    full(`Y-tunnus: ${organization.taxCode}`, 8, false, "center");
  separator();
  const paid = receipt.inputMoney != null;
  full(paid ? "Kuitti" : "Esilasku", 11, true, "center");
  if (receipt.billId != null) pair("Kuittinumero", `#${receipt.billId}`);
  pair(
    "Päivämäärä",
    new Intl.DateTimeFormat("fi-FI", {
      timeZone: "Europe/Helsinki",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(receipt.date),
  );
  pair(
    "Kellonaika",
    new Intl.DateTimeFormat("fi-FI", {
      timeZone: "Europe/Helsinki",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(receipt.date),
  );
  if (receipt.serviceType === "TAKEAWAY") {
    pair("Palvelutapa", "Mukaan");
    if (receipt.pickupNo != null) pair("Noutonumero", `#${receipt.pickupNo}`);
  } else if (receipt.tableNo != null) pair("Pöytä", receipt.tableNo);
  if (receipt.cashierName) pair("Kassahenkilö", receipt.cashierName);
  if (receipt.payType)
    pair("Maksutapa", receipt.payType === "cash" ? "Käteinen" : "Pankkimaksu");
  separator();
  pair("Tuote", "Rivihinta", 8, true);
  for (const line of groupReceiptLines(receipt.lines)) {
    const unitPrice = line.price + line.moneyAdded;
    pair(line.foodName, formatMoney(unitPrice * line.quantity), 9, true);
    full(`${line.quantity} × ${formatMoney(unitPrice)}`);
    if (line.foodSizeName) full(`Koko: ${line.foodSizeName}`);
    if (line.tasteName) full(`Lisävalinnat: ${line.tasteName}`);
    y += 3;
  }
  separator();
  // EN: Subtotal and extras describe stored line snapshots; the authoritative grand total is always BillSale.amount.
  // FI: Välisumma ja lisämaksut kuvaavat tallennettuja rivejä; määräävä yhteissumma on aina BillSale.amount.
  pair(
    "Välisumma",
    formatMoney(receipt.lines.reduce((sum, line) => sum + line.price, 0)),
  );
  const extras = receipt.lines.reduce((sum, line) => sum + line.moneyAdded, 0);
  if (extras !== 0) pair("Lisämaksut", formatMoney(extras));
  pair("Yhteensä", formatMoney(receipt.amount), 11, true);
  if (paid) {
    pair("Maksettu", formatMoney(receipt.inputMoney));
    if (receipt.payType === "cash")
      pair("Vaihtoraha", formatMoney(receipt.returnMoney));
  }
  separator();
  full(
    paid ? "Kiitos käynnistä!" : "Esilasku - ei maksukuitti",
    9,
    true,
    "center",
  );
  if (organization.website) full(organization.website, 8, false, "center");
  if (receipt.payType === "bank" && organization.bankNo)
    full(`Tilinumero: ${organization.bankNo}`, 8, false, "center");
  return { operations, height: Math.ceil(y + padding + 4) };
};

// EN: Size the 80 mm slip from measured content; the preview and print use these same PDF bytes.
// FI: Mitoita 80 mm kuitti mitatusta sisällöstä; esikatselu ja tulostus käyttävät samoja PDF-tavuja.
const renderReceiptPdf = async (organization, receipt) => {
  const measurement = createDocument(100000);
  measurement.resume();
  let layout;
  try {
    layout = receiptLayout(measurement, organization, receipt);
  } finally {
    measurement.end();
  }
  return new Promise((resolve, reject) => {
    const doc = createDocument(Math.max(280, layout.height));
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      for (const operation of layout.operations) {
        if (operation.type === "text") {
          doc
            .font(operation.font)
            .fontSize(operation.size)
            .text(operation.value, operation.x, operation.y, operation.options);
        } else if (operation.type === "separator") {
          doc
            .save()
            .lineWidth(0.5)
            .dash(2, { space: 2 })
            .moveTo(padding, operation.y)
            .lineTo(paperWidth - padding, operation.y)
            .stroke()
            .restore();
        } else {
          doc.image(operation.path, paperWidth / 2 - 24, operation.y, {
            fit: [48, 44],
            align: "center",
            valign: "center",
          });
        }
      }
      doc.end();
    } catch (error) {
      reject(error);
      doc.end();
    }
  });
};

const sendReceiptPdf = async (res, organization, receipt, fileName) => {
  const pdf = await renderReceiptPdf(organization, receipt);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
  });
  return res.send(pdf);
};

module.exports = { renderReceiptPdf, sendReceiptPdf };
