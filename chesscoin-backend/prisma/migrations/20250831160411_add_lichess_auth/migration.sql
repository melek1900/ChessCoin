-- CreateTable
CREATE TABLE "public"."LichessAuth" (
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LichessAuth_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "public"."LichessAuth" ADD CONSTRAINT "LichessAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
