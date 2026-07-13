const { PrismaClient } = require("@prisma/client");
const { count, error, table } = require("node:console");
const prisma = new PrismaClient();

module.exports = {
  create: async (req, res) => {
    try {
      console.log("body:", req.body);

      const rowSaleTemp = await prisma.saleTemp.findFirst({
        where: {
          userId: Number(req.body.userId),
          tableNo: Number(req.body.tableNo),
          foodId: Number(req.body.foodId),
        },
      });
      if (!rowSaleTemp) {
        await prisma.saleTemp.create({
          data: {
            userId: Number(req.body.userId),
            tableNo: Number(req.body.tableNo),
            foodId: Number(req.body.foodId),
            qty: 1,
          },
        });
      } else {
        await prisma.saleTemp.update({
          where: {
            id: rowSaleTemp.id,
          },
          data: {
            qty: rowSaleTemp.qty + 1,
          },
        });
      }
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  list: async (req, res) => {
    try {
      const saleTemps = await prisma.saleTemp.findMany({
        include: {
          saleTempDetails: {
            include: {
              Food: true,
              Taste: true,
              FoodSize: true,
            },
          },
          Food: true,
        },
        orderBy: {
          id: "desc",
        },
      });
      return res.send({ results: saleTemps });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  remove: async (req, res) => {
    try {
      const saleTempId = parseInt(req.params.id);
      await prisma.saleTempDetail.deleteMany({
        where: {
          saleTempId: saleTempId,
        },
      });
      await prisma.saleTemp.delete({
        where: {
          id: saleTempId,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  removeAll: async (req, res) => {
    try {
      const userId = Number(req.body.userId);
      const tableNo = Number(req.body.tableNo);

      await prisma.SaleTempDetail.deleteMany({
        where: {
          SaleTemp: {
            userId: userId,
            tableNo: tableNo,
          },
        },
      });
      await prisma.saleTemp.deleteMany({
        where: {
          userId,
          tableNo,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  updateQty: async (req, res) => {
    try {
      const qty = Number(req.body.qty);
      const id = Number(req.body.id);

      if (!Number.isInteger(qty) || qty < 1) {
        return res
          .status(400)
          .send({ error: "qty ต้องเป็นจำนวนเต็มและมากกว่าหรือเท่ากับ 1" });
      }

      // 1. อัปเดต qty ของตัวหลักก่อน
      const updatedSaleTemp = await prisma.saleTemp.update({
        where: { id: id },
        data: { qty: qty },
        include: { saleTempDetails: true }, // ดึงรายการย่อยปัจจุบันมาเช็คด้วย
      });

      const currentDetailsCount = updatedSaleTemp.saleTempDetails.length;

      // 2. ปรับจำนวนแถวใน saleTempDetail ให้เท่ากับ qty ใหม่
      if (qty > currentDetailsCount) {
        // ถ้า qty มากกว่าแถวที่มีอยู่ -> สร้างเพิ่มส่วนต่าง
        const diff = qty - currentDetailsCount;
        for (let i = 0; i < diff; i++) {
          await prisma.saleTempDetail.create({
            data: {
              saleTempId: id,
              foodId: updatedSaleTemp.foodId,
            },
          });
        }
      } else if (qty < currentDetailsCount) {
        // ถ้า qty น้อยกว่าแถวที่มีอยู่ (ตอนกดปุ่มลบ) -> ลบแถวเกินออกโดยเรียงจาก id ล่าสุด
        const diff = currentDetailsCount - qty;
        const detailsToDelete = await prisma.saleTempDetail.findMany({
          where: { saleTempId: id },
          orderBy: { id: "desc" },
          take: diff,
        });

        const deleteIds = detailsToDelete.map((d) => d.id);
        await prisma.saleTempDetail.deleteMany({
          where: { id: { in: deleteIds } },
        });
      }

      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  generateSaleTempDetail: async (req, res) => {
    try {
      const id = parseInt(req.body.saleTempId);

      const saleTemp = await prisma.saleTemp.findFirst({
        where: {
          id: id,
        },
        include: {
          saleTempDetails: true,
        },
      });

      if (!saleTemp) {
        return res.status(404).send({ error: "SaleTemp not found" });
      }

      if (saleTemp.saleTempDetails.length === 0) {
        for (let i = 0; i < saleTemp.qty; i++) {
          await prisma.saleTempDetail.create({
            data: {
              saleTempId: saleTemp.id,
              foodId: saleTemp.foodId,
            },
          });
        }
      }

      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  info: async (req, res) => {
    try {
      const saleTemp = await prisma.saleTemp.findFirst({
        where: {
          id: parseInt(req.params.id),
        },
        include: {
          Food: {
            include: {
              FoodType: {
                include: {
                  tastes: {
                    where: { status: "use" },
                  },
                  foodSizes: {
                    where: { status: "use" },
                    orderBy: { moneyAdded: "asc" },
                  },
                },
              },
            },
          },
          saleTempDetails: {
            include: { Food: true, FoodSize: true },
            orderBy: { id: "asc" },
          },
        },
      });

      if (!saleTemp) {
        return res.status(404).send({ error: "SaleTemp not found" });
      }

      return res.send({ results: saleTemp });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  selectTaste: async (req, res) => {
    try {
      await prisma.saleTempDetail.update({
        where: {
          id: req.body.saleTempDetailId,
        },
        data: {
          tasteId: req.body.tasteId,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  unSelectTaste: async (req, res) => {
    try {
      await prisma.saleTempDetail.update({
        where: {
          id: req.body.saleTempDetailId,
        },
        data: {
          tasteId: null,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  selectSize: async (req, res) => {
    try {
      await prisma.saleTempDetail.update({
        where: {
          id: req.body.saleTempDetailId,
        },
        data: {
          foodSizeId: req.body.sizeId,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  createSaleTempDetail: async (req, res) => {
    try {
      const saleTempId = req.body.saleTempId;
      const saleTempDetail = await prisma.saleTempDetail.findFirst({
        where: {
          saleTempId: saleTempId,
        },
      });
      await prisma.saleTempDetail.create({
        data: {
          saleTempId: saleTempDetail.saleTempId,
          foodId: saleTempDetail.foodId,
        },
      });
      const countSaleTempDetail = await prisma.saleTempDetail.count({
        where: {
          saleTempId: saleTempId,
        },
      });
      await prisma.saleTemp.update({
        where: {
          id: saleTempDetail.saleTempId,
        },
        data: {
          qty: countSaleTempDetail,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  removeSaleTempDetailModal: async (req, res) => {
    try {
      const saleTempDetailId = req.body.saleTempDetailId;
      const saleTempDetail = await prisma.saleTempDetail.findFirst({
        where: {
          id: saleTempDetailId,
        },
      });
      await prisma.saleTempDetail.delete({
        where: {
          id: req.body.saleTempDetailId,
        },
      });
      const countSaleTempDetail = await prisma.SaleTempDetail.count({
        where: {
          saleTempId: saleTempDetail.saleTempId,
        },
      });
      await prisma.saleTemp.update({
        where: {
          id: saleTempDetail.saleTempId,
        },
        data: {
          qty: countSaleTempDetail,
        },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  printBillAfterPay: async (req, res) => {
    try {
      const organization = await prisma.organization.findFirst();

      const billSale = await prisma.billSale.findMany({
        where: {
          userId: req.body.userId,
          tableNo: req.body.tableNo,
          status: "use",
        },

        orderBy: {
          id: "desc",
        },
        include: {
          BillSaleDetails: {
            include: {
              Food: true,
            },
          },
        },
      });

      // ตรวจสอบก่อนว่ามีข้อมูลหรือไม่ เพื่อป้องกัน Error
      if (billSale.length === 0) {
        return res.status(404).send({ error: "Bill not found" });
      }

      // เลือกรายการแรกจาก Array (index 0)
      const selectedBill = billSale[0];
      const billSaleDetails = selectedBill.BillSaleDetails;

      const pdfkit = require("pdfkit");
      const fs = require("fs");
      const dayjs = require("dayjs");

      const paperWidth = 80;
      const padding = 3;

      const doc = new pdfkit({
        size: [paperWidth, 200],
        margin: {
          top: 3,
          bottom: 3,
          left: 3,
          right: 3,
        },
      });
      const fileName = `uploads/bill-${dayjs(new Date()).format("YYYYMMDDHHmmss")}.pdf`;
      const font = "Kanit/kanit-regular.ttf";

      doc.pipe(fs.createWriteStream(fileName));

      //i
      const imageWidth = 20;
      const positionX = paperWidth / 2 - imageWidth / 2;
      doc.image("uploads/" + organization.logo, positionX, 5, {
        align: "center",
        width: imageWidth,
        height: 20,
      });
      doc.moveDown();

      doc.font(font);
      doc.fontSize(5).text("***Bill***", 20, doc.y + 8);
      doc.fontSize(8);
      doc.text(organization.name, padding, doc.y);
      doc.fontSize(5);
      doc.text(organization.address);
      doc.text(`Phone:${organization.phone}`);
      doc.text(`taxNo${organization.taxCode}`);
      doc.text(`tableNo${req.body.tableNo}`, { align: "center" });
      doc.text(`day: ${dayjs(new Date()).format("DD/MM/YYYY HH:mm;ss")}`, {
        align: "center",
      });
      doc.text("menu", { align: "center" });
      doc.moveDown();

      const y = doc.y;
      doc.fontSize(4);
      doc.text("menu", padding, y);
      doc.text("price", padding + 18, y, { align: "right", width: 20 });
      doc.text("qty", padding + 36, y, { align: "right", width: 20 });
      doc.text("total", padding + 55, y, { align: "right" });

      doc.lineWidth(0.1);
      doc
        .moveTo(padding, y + 6)
        .lineTo(paperWidth - padding, y + 6)
        .stroke();

      billSaleDetails.map((item, index) => {
        const y = doc.y;
        doc.text(item.Food.name, padding, y);
        doc.text(item.Food.price, padding + 18, y, {
          align: "right",
          width: 20,
        });
        doc.text(1, padding + 36, y, { align: "right", width: 20 });
        doc.text(item.price * 1, padding + 55, y, {
          align: "right",
        });
      });

      let sumAmount = 0;
      billSaleDetails.forEach((item) => {
        sumAmount += item.price * 1;
      });
  
      doc.text(`total:${sumAmount}`, padding, doc.y, {
        align: "right",
        width: paperWidth - padding - padding,
      });
      doc.text(`received:$${selectedBill.inputMoney}`, padding, doc.y, {
        align: "right",
        width: paperWidth - padding - padding,
      });
      doc.text(`change:$${selectedBill.returnMoney}`, padding, doc.y, {
        align: "right",
        width: paperWidth - padding - padding,
      });
      doc.end();

      return res.send({ message: "success", fileName: fileName });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  printBillBeforePay: async (req, res) => {
    try {
      const organization = await prisma.organization.findFirst();

      const saleTemp = await prisma.saleTemp.findMany({
        include: {
          Food: true,
          saleTempDetails: true,
        },
        where: {
          userId: req.body.userId,
          tableNo: req.body.tableNo,
        },
      });

      const pdfkit = require("pdfkit");
      const fs = require("fs");
      const dayjs = require("dayjs");

      const paperWidth = 80;
      const padding = 3;

      const doc = new pdfkit({
        size: [paperWidth, 200],
        margin: {
          top: 3,
          bottom: 3,
          left: 3,
          right: 3,
        },
      });
      const fileName = `uploads/bill-${dayjs(new Date()).format("YYYYMMDDHHmmss")}.pdf`;
      const font = "Kanit/kanit-regular.ttf";

      doc.pipe(fs.createWriteStream(fileName));

      //i
      const imageWidth = 20;
      const positionX = paperWidth / 2 - imageWidth / 2;
      doc.image("uploads/" + organization.logo, positionX, 5, {
        align: "center",
        width: imageWidth,
        height: 20,
      });
      doc.moveDown();

      doc.font(font);
      doc.fontSize(5).text("***Bill***", 20, doc.y + 8);
      doc.fontSize(8);
      doc.text(organization.name, padding, doc.y);
      doc.fontSize(5);
      doc.text(organization.address);
      doc.text(`Phone:${organization.phone}`);
      doc.text(`taxNo${organization.taxCode}`);
      doc.text(`tableNo${req.body.tableNo}`, { align: "center" });
      doc.text(`day: ${dayjs(new Date()).format("DD/MM/YYYY HH:mm;ss")}`, {
        align: "center",
      });
      doc.text("menu", { align: "center" });
      doc.moveDown();

      const y = doc.y;
      doc.fontSize(4);
      doc.text("menu", padding, y);
      doc.text("price", padding + 18, y, { align: "right", width: 20 });
      doc.text("qty", padding + 36, y, { align: "right", width: 20 });
      doc.text("total", padding + 55, y, { align: "right" });

      doc.lineWidth(0.1);
      doc
        .moveTo(padding, y + 6)
        .lineTo(paperWidth - padding, y + 6)
        .stroke();

      saleTemp.map((item, index) => {
        const y = doc.y;
        doc.text(item.Food.name, padding, y);
        doc.text(item.Food.price, padding + 18, y, {
          align: "right",
          width: 20,
        });
        doc.text(item.qty, padding + 36, y, { align: "right", width: 20 });
        doc.text(item.Food.price * item.qty, padding + 55, y, {
          align: "right",
        });
      });

      let sumAmount = 0;
      saleTemp.forEach((item) => {
        sumAmount += item.Food.price * item.qty;
      });

      doc.text(`total:${sumAmount.toLocaleString("th-TH")}€`, {
        align: "right",
      });
      doc.end();

      return res.send({ message: "success", fileName: fileName });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  endSale: async (req, res) => {
    try {
      const saleTemps = await prisma.saleTemp.findMany({
        include: {
          saleTempDetails: {
            include: {
              Food: true,
            },
          },
          Food: true,
        },
        where: {
          userId: req.body.userId,
        },
      });

      const billSale = await prisma.billSale.create({
        data: {
          amount: req.body.amount,
          inputMoney: req.body.inputMoney,
          payType: req.body.payType,
          tableNo: req.body.tableNo,
          userId: req.body.userId,
          returnMoney: req.body.returnMoney,
        },
      });

      for (let i = 0; i < saleTemps.length; i++) {
        const item = saleTemps[i];

        if (item.saleTempDetails.length > 0) {
          for (let j = 0; j < item.saleTempDetails.length; j++) {
            const detail = item.saleTempDetails[j];
            await prisma.billSaleDetail.create({
              data: {
                billSaleId: billSale.id,
                foodId: detail.foodId,
                tastedId: detail.tasteId,
                moneyAdded: detail.moneyAdded,
                price: detail.Food.price,
              },
            });
          }
        } else {
          if (item.qty > 0) {
            for (let j = 0; j < item.qty; j++) {
              await prisma.billSaleDetail.create({
                data: {
                  billSaleId: billSale.id,
                  foodId: item.foodId,
                  price: item.Food.price,
                },
              });
            }
          }
        }
      }

      for (let i = 0; i < saleTemps.length; i++) {
        await prisma.saleTempDetail.deleteMany({
          where: {
            saleTempId: saleTemps[i].id,
          },
        });
      }

      await prisma.saleTemp.deleteMany({
        where: {
          userId: req.body.userId,
        },
      });

      res.send({ message: "success" });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
};
