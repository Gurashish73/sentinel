-- Represent the interval between a successful approval and its recorded outcome.
ALTER TYPE "IncidentStatus" ADD VALUE IF NOT EXISTS 'EXECUTING' AFTER 'AWAITING_APPROVAL';
