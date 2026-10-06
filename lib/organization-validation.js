const path = require("node:path");
// Coordinates text behavior for this module.
const text = (value) => (typeof value === "string" ? value.trim() : "");
// Coordinates safe logo name behavior for this module.
const safeLogoName = (value) =>
  typeof value === "string" &&
  value.length <= 160 &&
  (value === "" || (path.basename(value) === value && !value.includes("\0")));
// Coordinates valid url behavior for this module.
const validUrl = (value) => {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
    return Boolean(url.hostname);
  } catch {
    return false;
  }
};
// Validates organization fields before persistence.
const validateOrganization = (body) => {
  const data = {
    name: text(body?.name),
    address: text(body?.address),
    phone: text(body?.phone),
    email: text(body?.email),
    website: text(body?.website),
    bankNo: text(body?.bankNo),
    logo: body?.logo ?? "",
    taxCode: text(body?.taxCode),
  };
  if (!data.name || data.name.length > 150)
    return { error: "Name must be 1-150 characters" };
  if (!data.address || data.address.length > 500)
    return { error: "Address must be 1-500 characters" };
  if (!data.phone || data.phone.length > 50)
    return { error: "Phone must be 1-50 characters" };
  if (
    data.email.length > 254 ||
    (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
  )
    return { error: "Email is invalid" };
  if (data.website.length > 250 || !validUrl(data.website))
    return { error: "Website must be an http or https URL" };
  if (data.bankNo.length > 100)
    return { error: "Bank number must be at most 100 characters" };
  if (!data.taxCode || data.taxCode.length > 50)
    return { error: "Tax code must be 1-50 characters" };
  if (!safeLogoName(data.logo)) return { error: "Invalid logo filename" };
  return data;
};
module.exports = { validateOrganization, safeLogoName };
