#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE auth_db;
	CREATE DATABASE product_db;
	CREATE DATABASE auction_db;
	CREATE DATABASE order_db;
	CREATE DATABASE payment_db;
	CREATE DATABASE notification_db;
EOSQL
