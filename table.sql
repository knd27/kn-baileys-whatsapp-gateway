CREATE TABLE `messages` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `messageId` varchar(50) NOT NULL,
  `timestamp` datetime DEFAULT NULL,
  `senderNumber` varchar(20) DEFAULT NULL,
  `remoteJid` varchar(30) DEFAULT NULL,
  `pushName` varchar(40) DEFAULT NULL,
  `text` text DEFAULT NULL,
  `media` varchar(120) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

ALTER TABLE `messages`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `messageId` (`messageId`);

ALTER TABLE `messages`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;