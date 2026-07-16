const { PrismaClient } = require("@prisma/client");
const dayjs = require("dayjs");
const prisma = new PrismaClient();

module.exports = {
  sumPerDayInYearAndMonth: async (req, res) => {
    try {
      const year = req.body.year;
      const month = req.body.month;

      const sumPerDay = [];
      const startDate = dayjs(year + "-" + month + "-01");
    const endDate = startDate.endOf("month").add(1, "day");

      for (let day = startDate.date(); day <= endDate.date(); day++) {
        const dateFrom = startDate.date(day).format("YYYY-MM-DD");
        const dateTo = startDate.date(day).add(1, "day").format("YYYY-MM-DD");

        const billSales = await prisma.billSale.findMany({
          where: {
            createdDate: {
              gte: new Date(dateFrom),
              lte: new Date(dateTo),
            },
            status: "use",
          },
          include: {
            BillSaleDetails: true,
          },
        });
        let sum = 0;

        for (let i = 0; i < billSales.length; i++) {
          const billSaleDetails = billSales[i].BillSaleDetails;

          for (let j = 0; j < billSaleDetails.length; j++) {
            sum += billSaleDetails[j].price + billSaleDetails[j].moneyAdded;
          }
        }
        sumPerDay.push({
          date: dateFrom,
          amount: sum,
        });
      }
      return res.send({ results: sumPerDay });
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
  },
  sumMonthly: async (req, res) => {
    try {
      const year = req.body.year;
      const sumMonthly = [];

      for (let month = 1; month <= 12; month++) {
        const startDate = dayjs(year + "-" + month + "-01");
        const endDate = startDate.endOf("month").add(1, "day");

        const billSales = await prisma.billSale.findMany({
          where:{
            createdDate :{
              gte: new Date(startDate.format('YYYY-MM-DD')),
              lte:new Date(endDate.format('YYYY-MM-DD'))
            },
            status:'use'
          },
          include:{
               BillSaleDetails: true,
          }
        })
        let sum = 0;

        for (let i = 0; i < billSales.length; i++) {
          const billSaleDetails = billSales[i].BillSaleDetails;

           for (let j = 0; j < billSaleDetails.length; j++) {
           sum += billSaleDetails[j].price + billSaleDetails[j].moneyAdded;
          }
        }
        sumMonthly.push({
          month:startDate.format('MM'),
          amount:sum
        })
      }
      return res.send({results:sumMonthly})
    } catch (e) {
      return res.status(500).send({ error: e.message });
    }
},

}
