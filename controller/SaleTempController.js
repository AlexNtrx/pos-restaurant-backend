const { PrismaClient } = require("@prisma/client");
const { count } = require("node:console");
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
          saleTempId:saleTempId
        },
      });
      await prisma.saleTemp.delete({
        where:{
          id:saleTempId
        }
      })
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
      include: { saleTempDetails: true } // ดึงรายการย่อยปัจจุบันมาเช็คด้วย
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
            foodId: updatedSaleTemp.foodId
          }
        });
      }
    } else if (qty < currentDetailsCount) {
      // ถ้า qty น้อยกว่าแถวที่มีอยู่ (ตอนกดปุ่มลบ) -> ลบแถวเกินออกโดยเรียงจาก id ล่าสุด
      const diff = currentDetailsCount - qty;
      const detailsToDelete = await prisma.saleTempDetail.findMany({
        where: { saleTempId: id },
        orderBy: { id: "desc" },
        take: diff
      });
      
      const deleteIds = detailsToDelete.map(d => d.id);
      await prisma.saleTempDetail.deleteMany({
        where: { id: { in: deleteIds } }
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
};
