const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

module.exports = {
  create: async (req, res) => {
    try {
      const oldOrganization = await prisma.organization.findMany();
      const payload = {
        name: req.body.name,
        phone: req.body.phone,
        address: req.body.address,
        email: req.body.email,
        website: req.body.website,
        bankNo: req.body.bankNo,
        logo: req.body.logo,
        taxCode: req.body.taxCode,
      };
      if (oldOrganization.length == 0) {
        await prisma.organization.create({
          data: payload,
        });
      } else {
        await prisma.organization.update({
          where: {
            id: oldOrganization[0].id,
          },
          data: payload,
        });
      }
      res.send({ message: "success" });
    } catch (error) {
      res.status(500).send({ error: error.message });
    }
  },
  info: async (req, res) => {
    try {
      const organization = await prisma.organization.findFirst();
      res.send({ result: organization });
    } catch (error) {
      res.status(500).send({ error: error.message });
    }
  },
  upload: async (req, res) => {
    try {
      const file = req.files.file;

      const extension = file.name.split(".").pop();

      const fileName = `logo_${Date.now()}.${extension}`;

      file.mv(`./uploads/${fileName}`);

      const organization = await prisma.organization.findFirst();

      if (organization) {
        const fs = require("fs");
        fs.unlinkSync(`./uploads/${organization.logo}`);

        await prisma.organization.update({
          where: {
            id: organization.id,
          },
          data: {
            logo: fileName,
          },
        });
      }

      res.send({ fileName: fileName });
    } catch (error) {
      res.status(500).send({ error: error.message });
    }
  },
};
