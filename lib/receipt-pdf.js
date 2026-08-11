const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

// Manages render receipt pdf while preserving cleanup behavior.
const renderReceiptPdf = (organization, receipt) =>
  new Promise((resolve, reject) => {
    const paperWidth = 226.77;
    const paperHeight = Math.max(280, 190 + receipt.lines.length * 18);
    const padding = 12;
    const doc = new PDFDocument({
      size: [paperWidth, paperHeight],
      margins: { top: 12, bottom: 12, left: padding, right: padding },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const logoPath =
        organization.logo &&
        path.basename(organization.logo) === organization.logo
          ? path.join("uploads", organization.logo)
          : null;
      if (logoPath && fs.existsSync(logoPath)) {
        doc.image(logoPath, paperWidth / 2 - 25, 12, {
          fit: [50, 50],
          align: "center",
        });
        doc.moveDown(3);
      }
      doc.font("Kanit/kanit-regular.ttf");
      doc.fontSize(12).text(receipt.title, { align: "center" });
      doc.fontSize(10).text(organization.name, { align: "center" });
      doc.fontSize(8).text(organization.address);
      doc.text(`Phone: ${organization.phone}`);
      doc.text(`Tax No: ${organization.taxCode}`);
      doc.text(`Table: ${receipt.tableNo}`, { align: "center" });
      if (receipt.billId)
        doc.text(`Bill: ${receipt.billId}`, { align: "center" });
      doc.text(`Date: ${receipt.date.toISOString()}`, { align: "center" });
      doc.moveDown();

      receipt.lines.forEach((line) => {
        const optionText = [line.foodSizeName, line.tasteName]
          .filter(Boolean)
          .join(", ");
        doc.fontSize(8).text(line.foodName);
        if (optionText) doc.fontSize(7).text(optionText);
        doc
          .fontSize(8)
          .text(
            `${line.price} + ${line.moneyAdded} = ${line.price + line.moneyAdded}`,
            {
              align: "right",
            },
          );
      });

      doc.moveDown();
      doc.fontSize(9).text(`Total: ${receipt.amount}`, { align: "right" });
      if (receipt.inputMoney != null) {
        doc.text(`Received: ${receipt.inputMoney}`, { align: "right" });
        doc.text(`Change: ${receipt.returnMoney}`, { align: "right" });
        doc.text(`Payment: ${receipt.payType}`, { align: "right" });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });

// Manages send receipt pdf while preserving cleanup behavior.
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
