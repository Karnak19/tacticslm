CREATE TABLE `matches` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`roomId` text NOT NULL,
	`status` text NOT NULL,
	`walls` text NOT NULL,
	`gridSize` integer NOT NULL,
	`turnNumber` integer NOT NULL,
	`roundNumber` integer NOT NULL,
	`turnCap` integer NOT NULL,
	`initiative` text NOT NULL,
	`initiativeIndex` integer NOT NULL,
	`currentUnitId` text,
	`effects` text NOT NULL,
	`winnerTeam` text,
	FOREIGN KEY (`roomId`) REFERENCES `rooms`(`_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `matches_by_room` ON `matches` (`roomId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`matchId` text NOT NULL,
	`unitId` text NOT NULL,
	`team` text NOT NULL,
	`turnNumber` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`matchId`) REFERENCES `matches`(`_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unitId`) REFERENCES `units`(`_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_by_match_and_team` ON `messages` (`matchId`,`team`);--> statement-breakpoint
CREATE TABLE `players` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`roomId` text NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`team` text NOT NULL,
	`ready` integer NOT NULL,
	FOREIGN KEY (`roomId`) REFERENCES `rooms`(`_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `players_by_room` ON `players` (`roomId`);--> statement-breakpoint
CREATE INDEX `players_by_user` ON `players` (`userId`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`code` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_by_code` ON `rooms` (`code`);--> statement-breakpoint
CREATE TABLE `rosterUnits` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`personality` text NOT NULL,
	`model` text NOT NULL,
	`skin` text,
	`loadout` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rosterUnits_by_user` ON `rosterUnits` (`userId`);--> statement-breakpoint
CREATE TABLE `turns` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`matchId` text NOT NULL,
	`turnNumber` integer NOT NULL,
	`unitId` text NOT NULL,
	`moveTo` text,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`thinking` text,
	FOREIGN KEY (`matchId`) REFERENCES `matches`(`_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unitId`) REFERENCES `units`(`_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turns_by_match` ON `turns` (`matchId`,`turnNumber`);--> statement-breakpoint
CREATE TABLE `units` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`roomId` text NOT NULL,
	`playerId` text NOT NULL,
	`team` text NOT NULL,
	`name` text NOT NULL,
	`personality` text NOT NULL,
	`model` text NOT NULL,
	`skin` text,
	`loadout` text NOT NULL,
	`position` text,
	`hp` integer,
	`alive` integer,
	`activeCooldown` integer,
	`usedConsumables` text,
	`lastActedRound` integer,
	FOREIGN KEY (`roomId`) REFERENCES `rooms`(`_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playerId`) REFERENCES `players`(`_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `units_by_room` ON `units` (`roomId`);--> statement-breakpoint
CREATE INDEX `units_by_player` ON `units` (`playerId`);--> statement-breakpoint
CREATE TABLE `users` (
	`_id` text PRIMARY KEY NOT NULL,
	`_creationTime` integer NOT NULL,
	`clerkId` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_by_clerk` ON `users` (`clerkId`);