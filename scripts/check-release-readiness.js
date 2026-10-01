#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = process.cwd();

function checkFileExists(filePath, description) {
  const fullPath = path.resolve(ROOT_DIR, filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing required release file: ${filePath} (${description})`);
    return false;
  }
  return true;
}

function main() {
  console.log("Checking release readiness checklist...");

  const requiredFiles = [
    ["package.json", "Root package configuration"],
    ["pnpm-lock.yaml", "Lockfile"],
    ["docs/API.md", "API documentation"],
    ["docs/ARCHITECTURE.md", "Architecture guide"],
    ["docs/WEBHOOKS.md", "Webhooks documentation"],
    ["docs/env-inventory.md", "Environment inventory"],
    ["backend/package.json", "Backend package configuration"],
    ["backend/prisma/schema.prisma", "Prisma schema definition"]
  ];

  let passed = true;

  for (const [file, desc] of requiredFiles) {
    if (!checkFileExists(file, desc)) {
      passed = false;
    }
  }

  if (!passed) {
    console.error("Release readiness checklist failed.");
    process.exit(1);
  }

  console.log("Release readiness checklist passed.");
}

main();
