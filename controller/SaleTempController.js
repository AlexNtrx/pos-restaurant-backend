const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

module.exports = {
  create: async (req, res) => {
    try {
      const rowSaleTemp = await prisma.saleTemp.findFirst({
        where: {
          userId: req.body.userId,
          tableNo: req.body.tableNo,
        },
      });
      let saleTempId = 0;
      if (!rowSaleTemp) {
        const saleTemp = await prisma.saleTemp.create({
          data: {
            userId: req.body.userId,
            tableNo: req.body.tableNo,
          },
        });
        saleTempId = saleTemp.id;
      } else {
        saleTempId = rowSaleTemp.id;
      }

      await prisma.saleTempDetail.create({
        data: {
          saleTempId: saleTempId,
          foodId: req.body.foodId,
        },
      });

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
        },
      });
      return res.send({ results: saleTemps });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
};
