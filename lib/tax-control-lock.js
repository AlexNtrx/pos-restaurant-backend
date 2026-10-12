const { readControlState } = require("./tax-control-service");
const { positiveId, unavailable } = require("./tax-control-validation");
const assertTransaction = (tx, organizationId) => {
  if (!positiveId(organizationId)) unavailable();
  if (!tx || typeof tx.$queryRaw !== "function" || tx.$transaction)
    throw new TypeError("Tax control locks require an existing transaction");
};

// EN: The caller owns the transaction and must acquire this lock before resource locks; no runtime writer uses it yet.
// FI: Kutsuja omistaa transaktion ja ottaa tämän lukon ennen resurssilukkoja; ajonaikaiset kirjoittajat eivät vielä käytä sitä.
const lockTaxControlShared = async (tx, organizationId) => {
  assertTransaction(tx, organizationId);
  const [control] =
    await tx.$queryRaw`SELECT * FROM "OrganizationTaxControl" WHERE "organizationId" = ${organizationId} FOR SHARE`;
  if (!control) unavailable();
  return readControlState(tx, organizationId, control);
};
const lockTaxControlExclusive = async (tx, organizationId) => {
  assertTransaction(tx, organizationId);
  const [control] =
    await tx.$queryRaw`SELECT * FROM "OrganizationTaxControl" WHERE "organizationId" = ${organizationId} FOR UPDATE`;
  if (!control) unavailable();
  return readControlState(tx, organizationId, control);
};
module.exports = { lockTaxControlShared, lockTaxControlExclusive };
