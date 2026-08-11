-- An account may be reused after it is soft-deleted, but two active accounts
-- must never share a sign-in username.
CREATE UNIQUE INDEX "User_active_username_key"
ON "User"("username")
WHERE "status" = 'use';
