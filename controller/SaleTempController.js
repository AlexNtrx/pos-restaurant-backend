const { PrismaClient } = require("@prisma/client");
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
      await prisma.saleTemp.delete({
        where: {
          id: Number(req.params.id),
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

      if (!Number.isInteger(qty) || qty < 1) {
        return res
          .status(400)
          .send({ error: "qty ต้องเป็นจำนวนเต็มและมากกว่าหรือเท่ากับ 1" });
      }

      await prisma.saleTemp.update({
        where: {
          id: Number(req.body.id),
        },
        data: {
          qty: qty,
        },
      });
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
      const saleTemp = await prisma.saleTemp.findFirst({   // ✅ เปลี่ยนจาก saleTempDetail → saleTemp
        where: {
          id: parseInt(req.params.id),                      // ✅ เปลี่ยนจาก saleTempId → id
        },
        include: {
          Food: {
            include: {
              FoodType: {
                include: {
                  tastes: {                                 // ✅ lowercase
                    where: { status: "use" },                // ✅ string ไม่ใช่ boolean
                  },
                  foodSizes: {                               // ✅ lowercase
                    where: { status: "use" },
                    orderBy: { moneyAdded: "asc" },
                  },
                },
              },
            },
          },
          saleTempDetails: {
            include: { Food: true },
            orderBy: { id: "asc" },
          },
        },
      });

      if (!saleTemp) {
        return res.status(404).send({ error: "SaleTemp not found" });
      }

      return res.send({ results: saleTemp });               // ✅ ตัวแปรตรงกับที่ query ได้จริง
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
};
