-- CreateTable
CREATE TABLE "user_list_preferences" (
    "userId" TEXT NOT NULL,
    "listKey" TEXT NOT NULL,
    "pageSize" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_list_preferences_pkey" PRIMARY KEY ("userId","listKey")
);

-- AddForeignKey
ALTER TABLE "user_list_preferences" ADD CONSTRAINT "user_list_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The UI offers 25 / 50 / 100 per page (lib/list/pagination.ts PAGE_SIZE_OPTIONS).
ALTER TABLE "user_list_preferences" ADD CONSTRAINT "user_list_preferences_page_size_check" CHECK ("pageSize" IN (25, 50, 100));
