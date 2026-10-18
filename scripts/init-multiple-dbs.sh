#!/bin/bash
set -e

function create_database() {
	local database=$1
	echo "  Checking / creating database '$database' if not exists..."
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
		SELECT 'CREATE DATABASE $database'
		WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$database')
		\gexec
EOSQL
}

create_database auth_db
create_database product_db
create_database auction_db
create_database order_db
create_database payment_db
create_database notification_db
