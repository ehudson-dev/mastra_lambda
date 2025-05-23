const fs = require("fs");
const path = require("path");

/**
 * Recursively rename all .js files to .mjs in a directory & fix /index imports to include file extension
 * @param {string} dirPath - Directory path to process
 */
function fixCompilation(dirPath, stats = { dirs: 0, jsFiles: 0, skipped: 0 }) {
  try {
    console.log(`Scanning directory: ${dirPath}`);
    const items = fs.readdirSync(dirPath);
    console.log(`Found ${items.length} items in ${dirPath}`);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        stats.dirs++;
        // Skip node_modules and other common directories you might want to ignore
        if (["node_modules", ".git", "dist", "build"].includes(item)) {
          console.log(`Skipping directory: ${fullPath}`);
          stats.skipped++;
        } else {
          console.log(`Entering directory: ${fullPath}`);
          fixCompilation(fullPath, stats);
        }
      } else if (stat.isFile()) {
        console.log(`Found file: ${fullPath}`);
        if (item.endsWith(".js")) {
          stats.jsFiles++;
          const newName = item.replace(/\.js$/, ".mjs");
          const newPath = path.join(dirPath, newName);

          fs.renameSync(fullPath, newPath);

          let content = fs.readFileSync(newPath, "utf8");
          content = content.replace(
            /from ['"`]([^'"`]+)\/index['"`]/g,
            "from '$1/index.mjs'"
          );

          fs.writeFileSync(newPath, content);

          console.log(`Renamed: ${fullPath} -> ${newPath}`);
        }
      }
    }

    return stats;
  } catch (error) {
    console.error(`Error processing directory ${dirPath}:`, error.message);
    return stats;
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

// Get target directory (default to current directory)
const targetDir =
  args.find((arg) => !arg.startsWith("--") && !arg.startsWith("-")) || ".";

if (!fs.existsSync(targetDir)) {
  console.error(`Error: Directory "${targetDir}" does not exist.`);
  process.exit(1);
}

console.log(`Processing directory: ${path.resolve(targetDir)}`);
const stats = fixCompilation(targetDir, { dirs: 0, jsFiles: 0, skipped: 0 });
console.log("\n=== Summary ===");
console.log(`Directories scanned: ${stats.dirs}`);
console.log(`Directories skipped: ${stats.skipped}`);
console.log(`JS files found: ${stats.jsFiles}`);
console.log("Done!");
