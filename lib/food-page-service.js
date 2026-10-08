const { Prisma } = require("@prisma/client");

const readInteger = (value, fallback, max) => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
};

const parseFoodPageQuery = (query) => {
  const page = readInteger(query.page, 1, 1_000_000);
  const pageSize = readInteger(query.limit, 24, 100);
  const categoryId = readInteger(query.categoryId, undefined, 2_147_483_647);
  if (page === null || pageSize === null || categoryId === null)
    return { error: "Invalid page, limit, or categoryId" };
  if (query.q !== undefined && typeof query.q !== "string")
    return { error: "q must be a string" };
  const search = (query.q ?? "").trim();
  if (search.length > 200 || search.includes("\0"))
    return { error: "q must be at most 200 characters without null bytes" };
  return { page, pageSize, categoryId, search };
};

// EN: Escape LIKE wildcards so catalog search keeps literal substring semantics.
// FI: Suojaa LIKE-jokerimerkit, jotta luettelohaussa etsitään kirjaimellista osamerkkijonoa.
const foodPageWhere = ({ categoryId, search }) => {
  const contains = search.replace(/[\\%_]/g, "\\$&");
  const text = { contains, mode: "insensitive" };
  return {
    status: "use",
    ...(categoryId === undefined ? {} : { foodTypeId: categoryId }),
    ...(search
      ? { OR: [{ name: text }, { remark: text }, { FoodType: { name: text } }] }
      : {}),
  };
};

// EN: Count, clamp and read within one snapshot; concurrent menu edits cannot produce an inconsistent page response.
// FI: Laske, rajaa ja lue samasta tilannekuvasta; samanaikaiset valikkomuutokset eivät tuota ristiriitaista sivuvastausta.
const readFoodPage = (prisma, filters) =>
  prisma.$transaction(
    async (tx) => {
      const where = foodPageWhere(filters);
      const totalCount = await tx.food.count({ where: { status: "use" } });
      const filteredCount =
        !filters.search && filters.categoryId === undefined
          ? totalCount
          : await tx.food.count({ where });
      const pageCount = Math.max(
        1,
        Math.ceil(filteredCount / filters.pageSize),
      );
      const page = Math.min(filters.page, pageCount);
      const results = await tx.food.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (page - 1) * filters.pageSize,
        take: filters.pageSize,
        select: {
          id: true,
          name: true,
          remark: true,
          price: true,
          img: true,
          detailImg: true,
          foodType: true,
          foodTypeId: true,
          FoodType: { select: { id: true, name: true, remark: true } },
        },
      });
      return {
        results,
        totalCount,
        filteredCount,
        page,
        pageSize: filters.pageSize,
        pageCount,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

module.exports = { parseFoodPageQuery, readFoodPage };
