const configurationIssues = (configuration) => {
  const issues = [];
  const add = (code, field) => issues.push({ code, field });
  if (!configuration) {
    add("SAVED_DRAFT_REQUIRED", "draft");
    return issues;
  }
  if (configuration.countryCode !== "FI") add("REQUIRED", "countryCode");
  if (configuration.vatStatus === "UNCONFIRMED") add("REQUIRED", "vatStatus");
  if (!configuration.requestedEffectiveDate)
    add("REQUIRED", "requestedEffectiveDate");
  if (!configuration.reviewerName) add("REQUIRED", "reviewerName");
  // EN: Non-registration requires absent rates; completeness never establishes legal approval or an active policy.
  // FI: Rekisteröimättömyys vaatii puuttuvat verokannat; tietojen täydellisyys ei vahvista oikeudellista hyväksyntää tai aktiivista käytäntöä.
  for (const key of ["FOOD_NON_ALCOHOLIC", "ALCOHOL"]) {
    if (
      configuration.vatStatus === "REGISTERED" &&
      configuration.rates[key] === null
    )
      add("REQUIRED", `rates.${key}`);
    if (
      configuration.vatStatus === "NOT_REGISTERED" &&
      configuration.rates[key] !== null
    )
      add("RATE_MUST_BE_EMPTY", `rates.${key}`);
  }
  if (
    configuration.vatStatus === "NOT_REGISTERED" &&
    !configuration.nonRegistrationReason
  )
    add("REQUIRED", "nonRegistrationReason");
  return issues;
};
module.exports = { configurationIssues };
