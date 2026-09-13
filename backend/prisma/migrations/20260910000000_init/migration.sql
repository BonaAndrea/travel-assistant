-- Initial versioned schema for the travel assistant.
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Destination" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "countryCode" TEXT,
    "city" TEXT NOT NULL,
    CONSTRAINT "Destination_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Airport" (
    "id" TEXT NOT NULL,
    "iataCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "destinationId" TEXT,
    CONSTRAINT "Airport_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Flight" (
    "id" TEXT NOT NULL,
    "originAirportId" TEXT NOT NULL,
    "destinationAirportId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "seatsAvailable" INTEGER NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Flight_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Hotel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "target" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "HotelAvailability" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "pricePerNight" DOUBLE PRECISION NOT NULL,
    "roomsAvailable" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "HotelAvailability_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "target" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ActivityAvailability" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "cost" DOUBLE PRECISION NOT NULL,
    "capacity" INTEGER NOT NULL,
    "booked" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ActivityAvailability_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Itinerary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "details" JSONB NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "flightCost" DOUBLE PRECISION NOT NULL,
    "hotelCost" DOUBLE PRECISION NOT NULL,
    "activityCost" DOUBLE PRECISION NOT NULL,
    "compromises" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Itinerary_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ItineraryGenerationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressLabel" TEXT NOT NULL DEFAULT 'In coda',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ItineraryGenerationJob_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itineraryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "failureReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PreferenceImage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "analysisStatus" TEXT NOT NULL DEFAULT 'metadata_only',
    "description" TEXT,
    "tags" JSONB,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreferenceImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "RefreshToken"("userId", "expiresAt");
CREATE INDEX "Destination_country_idx" ON "Destination"("country");
CREATE INDEX "Destination_countryCode_idx" ON "Destination"("countryCode");
CREATE UNIQUE INDEX "Destination_country_city_key" ON "Destination"("country", "city");
CREATE UNIQUE INDEX "Airport_iataCode_key" ON "Airport"("iataCode");
CREATE INDEX "Airport_destinationId_idx" ON "Airport"("destinationId");
CREATE INDEX "Flight_originAirportId_destinationAirportId_date_idx" ON "Flight"("originAirportId", "destinationAirportId", "date");
CREATE UNIQUE INDEX "HotelAvailability_hotelId_date_key" ON "HotelAvailability"("hotelId", "date");
CREATE INDEX "ActivityAvailability_activityId_date_idx" ON "ActivityAvailability"("activityId", "date");
CREATE UNIQUE INDEX "ActivityAvailability_activityId_date_startMinute_endMinute_key" ON "ActivityAvailability"("activityId", "date", "startMinute", "endMinute");
CREATE INDEX "Itinerary_conversationId_idx" ON "Itinerary"("conversationId");
CREATE INDEX "ItineraryGenerationJob_conversationId_createdAt_idx" ON "ItineraryGenerationJob"("conversationId", "createdAt");
CREATE INDEX "ItineraryGenerationJob_status_createdAt_idx" ON "ItineraryGenerationJob"("status", "createdAt");
CREATE UNIQUE INDEX "ItineraryGenerationJob_userId_idempotencyKey_key" ON "ItineraryGenerationJob"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "Booking_idempotencyKey_key" ON "Booking"("idempotencyKey");
CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");
CREATE UNIQUE INDEX "PreferenceImage_storageKey_key" ON "PreferenceImage"("storageKey");
CREATE INDEX "PreferenceImage_userId_conversationId_createdAt_idx" ON "PreferenceImage"("userId", "conversationId", "createdAt");
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Airport" ADD CONSTRAINT "Airport_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Destination"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Flight" ADD CONSTRAINT "Flight_originAirportId_fkey" FOREIGN KEY ("originAirportId") REFERENCES "Airport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Flight" ADD CONSTRAINT "Flight_destinationAirportId_fkey" FOREIGN KEY ("destinationAirportId") REFERENCES "Airport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Hotel" ADD CONSTRAINT "Hotel_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Destination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelAvailability" ADD CONSTRAINT "HotelAvailability_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Destination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityAvailability" ADD CONSTRAINT "ActivityAvailability_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Itinerary" ADD CONSTRAINT "Itinerary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Itinerary" ADD CONSTRAINT "Itinerary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_itineraryId_fkey" FOREIGN KEY ("itineraryId") REFERENCES "Itinerary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreferenceImage" ADD CONSTRAINT "PreferenceImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreferenceImage" ADD CONSTRAINT "PreferenceImage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
