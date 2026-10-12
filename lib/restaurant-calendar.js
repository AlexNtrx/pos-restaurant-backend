const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const RESTAURANT_TIME_ZONE = "Europe/Helsinki";

// EN: Resolve each local midnight independently; DST means a calendar day need not last 24 hours.
// FI: Muunna jokainen paikallinen keskiyö erikseen; kesäajan vuoksi kalenteripäivä ei aina kestä 24 tuntia.
const midnight = (year, monthIndex) =>
  dayjs
    .tz(
      new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10),
      RESTAURANT_TIME_ZONE,
    )
    .toDate();

const restaurantMonthBounds = (year, month) => ({
  start: midnight(year, month - 1),
  endExclusive: midnight(year, month),
});

const restaurantYearBounds = (year) => ({
  start: midnight(year, 0),
  endExclusive: midnight(year + 1, 0),
});

module.exports = {
  RESTAURANT_TIME_ZONE,
  restaurantMonthBounds,
  restaurantYearBounds,
};
