/*
  Warnings:

  - A unique constraint covering the columns `[orgId,externalId]` on the table `Event` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Event_orgId_externalId_key" ON "Event"("orgId", "externalId");
