-- Keep the applied foundation migration unchanged. Renaming the enum label also
-- updates existing PaymentAttempt values without recreating tables or indexes.
-- This corrects the development baseline; it does not confirm cash collection
-- or change any Payment/PaymentAttempt status.
ALTER TYPE "PaymentMethod" RENAME VALUE 'MOCK_GATEWAY' TO 'COD';
