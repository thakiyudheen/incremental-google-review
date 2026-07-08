require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Google Reviews Scraper is running in the background!");
});

app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

puppeteer.use(StealthPlugin());

const OUTPUT_DIR = path.join(__dirname, "output");
const JSON_FILE = path.join(OUTPUT_DIR, "google_maps_detailed_reviews.json");
const CSV_FILE = path.join(OUTPUT_DIR, "google_maps_detailed_reviews.csv");

// Max number of already-seen reviews to encounter before stopping the scrape early
const MAX_CONSECUTIVE_SEEN = 15;

function loadExistingReviews() {
  if (fs.existsSync(JSON_FILE)) {
    try {
      const data = fs.readFileSync(JSON_FILE, "utf8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Error reading existing reviews:", e.message);
      return [];
    }
  }
  return [];
}

async function scrapeGoogleMapsReviewsIncremental() {
  console.log(
    `[${new Date().toISOString()}] Starting incremental Google Maps Review Scrape...`,
  );

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // User requested not to check the output file for existing data
  const existingReviews = [];
  console.log(`Ignoring existing reviews as requested.`);

  // Create a Set of existing review signatures to quickly check if we've seen them
  const seenSignatures = new Set();

  // Determine if we are running in Render (production) or locally
  const isProduction = process.env.NODE_ENV === "production";

  const browser = await puppeteer.launch({
    // Headless must be true in production/Docker
    headless: true,
    userDataDir: path.join(__dirname, "chrome_session"),
    // Let Puppeteer auto-detect the browser
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--lang=en-US",
      "--window-size=1280,800",
      "--disable-blink-features=AutomationControlled",
      ...(isProduction
        ? ["--disable-dev-shm-usage", "--single-process", "--no-zygote"]
        : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = await browser.newPage();
  // Enforce a strict Desktop User-Agent to prevent Google Maps from serving the stripped down/mobile layout
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log(`Navigating to Google Maps...`);
    const mapsUrl = process.env.GOOGLE_MAPS_URL;

    // Ensure Google Maps renders in English so our selectors work!
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    // Increase timeout to 90 seconds because Render's free tier CPU is very slow
    await page.goto(mapsUrl, { waitUntil: "domcontentloaded", timeout: 90000 });

    console.log(`Navigated to Google Map with Url...`);

    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

    // Accept cookies
    try {
      const acceptBtn = await page.$('button[aria-label="Accept all"]');
      if (acceptBtn) {
        await acceptBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        console.log("Accepted cookies.");
      }
    } catch (e) {}

    // await page.waitForSelector('h1', { timeout: 15000 });

    console.log('Looking for the "Reviews" tab...');
    let clickedReviews = true;

    // const tryFindReviewsTab = async () => {
    //     const tabs = await page.$$('button[role="tab"]');
    //     for (const tab of tabs) {
    //         const text = await page.evaluate(el => el.textContent, tab);
    //         if (text && text.includes('Reviews')) {
    //             await tab.click();
    //             return true;
    //         }
    //     }
    //     return false;
    // };

    // // Try for up to 5 seconds to find the reviews tab or fallback (handling slow DOM renders)
    // for (let attempt = 0; attempt < 5; attempt++) {
    //     clickedReviews = await tryFindReviewsTab();
    //     if (clickedReviews) break;

    //     try {
    //         const fallbackBtn = await page.$('.wiquBf');
    //         if (fallbackBtn) {
    //             console.log('Reviews tab not found immediately. Trying .wiquBf fallback...');
    //             await fallbackBtn.click();
    //             console.log('Clicked .wiquBf fallback, waiting for UI to update...');
    //             await new Promise(r => setTimeout(r, 2000));
    //             clickedReviews = await tryFindReviewsTab();
    //             if (clickedReviews) break;
    //         }
    //     } catch (e) {
    //         console.log('Error clicking fallback: ' + e.message);
    //     }

    //     console.log(`Reviews tab not found on attempt ${attempt + 1}. Waiting 1 second...`);
    //     await new Promise(r => setTimeout(r, 1000));
    // }

    // if (clickedReviews) {
    //     console.log('Successfully opened Reviews section.');
    // } else {
    //     console.log('Could not find the "Reviews" tab. Taking a screenshot for debugging...');
    //     const screenshotBuffer = await page.screenshot({ fullPage: true });

    //     const error = new Error('Could not find the "Reviews" tab');
    //     error.screenshot = screenshotBuffer;
    //     throw error;
    // }

    // Wait briefly for the reviews to load fully before scrolling
    // Wait briefly for the reviews to load fully before scrolling
    console.log("Waiting 3 seconds for reviews to render...");
    await new Promise((r) => setTimeout(r, 3000));

    console.log("Scrolling to load reviews and checking for new ones...");

    let consecutiveSeen = 0;
    let newReviewsFoundThisRun = [];

    let previousReviewCount = 0;
    let sameCountIter = 0;
    let scrollIndex = 0;

    // Scroll incrementally until we reach the end of the list
    while (true) {
      scrollIndex++;
      await page.evaluate(async () => {
        const scrollableDiv =
          document.querySelector(".m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde") ||
          document.querySelector(".m6QErb.DxyBCb.kA9KIf.dS8AEf") ||
          document.querySelector('div[role="main"]');
        if (scrollableDiv) {
          scrollableDiv.scrollBy(0, 5000);
        }

        const loadedReviews = document.querySelectorAll("div[data-review-id]");
        if (loadedReviews.length > 0) {
          loadedReviews[loadedReviews.length - 1].scrollIntoView();
        }
        // Wait for network/lazy load
        await new Promise((resolve) => setTimeout(resolve, 1500));
      });

      // After each scroll, check the currently loaded reviews in DOM
      const rawReviews = await extractReviewsFromDOM(page);

      let foundTooOld = false;
      let foundNew = false;
      for (const r of rawReviews) {
        const rawDate = (r.dateOfReviewRaw || "").toLowerCase();

        // Check if older than 2 weeks
        if (
          rawDate.includes("month") ||
          rawDate.includes("year") ||
          rawDate.includes("2 weeks") ||
          rawDate.includes("3 weeks") ||
          rawDate.includes("4 weeks")
        ) {
          foundTooOld = true;
          continue;
        }

        const uniqueKey = `${r.reviewerName}_${r.reviewTextOriginal}`;

        // If it's completely new (not in existing JSON, and not extracted yet this run)
        if (
          !seenSignatures.has(uniqueKey) &&
          !newReviewsFoundThisRun.some(
            (nr) => `${nr.reviewerName}_${nr.reviewTextOriginal}` === uniqueKey,
          )
        ) {
          newReviewsFoundThisRun.push(r);
          foundNew = true;
          consecutiveSeen = 0; // Reset counter since we found a new one
        } else if (seenSignatures.has(uniqueKey)) {
          // It's a review we already have on disk
          consecutiveSeen++;
        }
      }

      console.log(
        `Scroll ${scrollIndex}: Found ${newReviewsFoundThisRun.length} valid new reviews so far. Total loaded in DOM: ${rawReviews.length}`,
      );

      if (rawReviews.length === previousReviewCount) {
        sameCountIter++;
        if (sameCountIter >= 3) {
          console.log("Reached the end of the review list! Stopping scroll.");
          break;
        }
      } else {
        sameCountIter = 0;
      }
      previousReviewCount = rawReviews.length;

      if (consecutiveSeen >= MAX_CONSECUTIVE_SEEN) {
        console.log(
          `Hit ${consecutiveSeen} consecutive already-saved reviews. Stopping scroll early!`,
        );
        break;
      }
    }

    if (newReviewsFoundThisRun.length === 0) {
      console.log("No new reviews found during this run. Finishing early.");
      return;
    }

    console.log(`Processing ${newReviewsFoundThisRun.length} new reviews...`);

    // Date Conversion Logic Helper
    const processDate = (rawDate) => {
      if (!rawDate) return { text: "", dateObj: new Date(0) };
      const now = new Date();
      let date = new Date();

      if (rawDate.includes("a day ago") || rawDate.includes("1 day ago")) {
        date.setDate(now.getDate() - 1);
      } else if (rawDate.includes("days ago")) {
        const days = parseInt(rawDate.split(" ")[0]);
        if (!isNaN(days)) date.setDate(now.getDate() - days);
      } else if (
        rawDate.includes("a month ago") ||
        rawDate.includes("1 month ago")
      ) {
        date.setMonth(now.getMonth() - 1);
      } else if (rawDate.includes("months ago")) {
        const months = parseInt(rawDate.split(" ")[0]);
        if (!isNaN(months)) date.setMonth(now.getMonth() - months);
      } else if (
        rawDate.includes("a year ago") ||
        rawDate.includes("1 year ago")
      ) {
        date.setFullYear(now.getFullYear() - 1);
      } else if (rawDate.includes("years ago")) {
        const years = parseInt(rawDate.split(" ")[0]);
        if (!isNaN(years)) date.setFullYear(now.getFullYear() - years);
      } else if (
        rawDate.includes("a week ago") ||
        rawDate.includes("1 week ago")
      ) {
        date.setDate(now.getDate() - 7);
      } else if (rawDate.includes("weeks ago")) {
        const weeks = parseInt(rawDate.split(" ")[0]);
        if (!isNaN(weeks)) date.setDate(now.getDate() - weeks * 7);
      } else if (
        rawDate.includes("an hour ago") ||
        rawDate.includes("hours ago") ||
        rawDate.includes("mins ago")
      ) {
        date = now;
      }

      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const year = date.getFullYear();
      return { text: `${month}/${day}/${year}`, dateObj: date };
    };

    const formattedNewReviews = newReviewsFoundThisRun.map((r) => {
      const dateParsed = processDate(r.dateOfReviewRaw);
      return {
        name: r.reviewerName,
        "profile Photo": r.profilePhoto,
        "LInk to review": r.profileLink,
        "Date of review": dateParsed.text,
        Ratings: r.rating,
        "Reveiw text orginal": r.reviewTextOriginal,
        "Review text translated": r.reviewTextTranslated,
        _dateObj: dateParsed.dateObj,
      };
    });

    // Combine new and old reviews
    const allReviews = [...formattedNewReviews, ...existingReviews];

    // Ensure sorting by date
    // Note: existingReviews might not have _dateObj anymore, so we only sort new ones and prepend them.
    formattedNewReviews.sort((a, b) => b._dateObj - a._dateObj);
    formattedNewReviews.forEach((r) => delete r._dateObj);

    const finalReviews = [...formattedNewReviews, ...existingReviews];

    console.log(
      `Writing combined total of ${finalReviews.length} reviews to disk...`,
    );
    fs.writeFileSync(JSON_FILE, JSON.stringify(finalReviews, null, 2));

    // Convert to CSV
    if (finalReviews.length > 0) {
      const header = Object.keys(finalReviews[0]);
      const csvRows = finalReviews.map((row) => {
        return header
          .map((fieldName) => {
            let field = row[fieldName];
            if (field === null || field === undefined) field = "";
            const str = String(field);
            if (str.includes('"') || str.includes(",") || str.includes("\n")) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(",");
      });
      const csvData = [header.join(","), ...csvRows].join("\n");
      fs.writeFileSync(CSV_FILE, csvData, "utf8");
    }
    console.log(
      `[̦${new Date().toISOString()}] Successfully completed incremental scrape! Added ${formattedNewReviews.length} new reviews.`,
    );

    // Send newly found reviews to Google Apps Script webhook
    if (formattedNewReviews.length > 0) {
      console.log(
        `Sending ${formattedNewReviews.length} new reviews to Google Apps Script webhook...`,
      );

      try {
        const webhookUrl =
          process.env.WEBHOOK_URL ||
          "https://script.google.com/macros/s/AKfycbw5ABwQHdZMsDsDkA_jrdsSBixnHUg5KyIidERy3wAAYtkOuyQIg0mPEraSTf4ODCLi1w/exec";

        const payload = finalReviews;

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "sync_reviews",
            data: payload,
          }),
          signal: AbortSignal.timeout(30000) // Added a 30-second timeout
        });

        const text = await response.text(); // IMPORTANT for debugging Apps Script

        console.log(`Webhook HTTP Status: ${response.status}`);
        console.log(`Webhook Response Body: ${text}`);

        try {
          const json = JSON.parse(text);
          console.log("Parsed Response:", json);
        } catch (e) {
          console.log("Response is not JSON");
        }
      } catch (err) {
        console.error("Failed to send reviews to webhook:", err.message);
      }
    }
  } catch (error) {
    console.error("Error occurred during scraping:", error);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

async function extractReviewsFromDOM(page) {
  return await page.evaluate(async () => {
    const results = [];
    const reviewElements = Array.from(
      document.querySelectorAll(".jftiEf, div[data-review-id]"),
    );
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    for (const el of reviewElements) {
      const nameEl = el.querySelector(".d4r55") || el.querySelector(".XjcHXc");
      let name = nameEl ? nameEl.textContent.trim() : "Unknown";

      const photoEl = el.querySelector(".NBa7we");
      let profilePhoto = photoEl ? photoEl.src : "";

      const linkEl = el.querySelector(
        'a[href*="/contrib/"], button[data-href*="/contrib/"]',
      );
      let profileLink = "";
      if (linkEl) {
        profileLink =
          linkEl.getAttribute("href") || linkEl.getAttribute("data-href");
      }

      const dateEl = el.querySelector(".rsqaWe");
      let rawDate = dateEl ? dateEl.textContent.trim() : "";

      const ratingEl = el.querySelector(".kvMYJc");
      let rating = "N/A";
      if (ratingEl) {
        const ariaLabel = ratingEl.getAttribute("aria-label");
        if (ariaLabel) {
          rating = ariaLabel.replace(/[^0-9.]/g, "");
        }
      }

      const textEl = el.querySelector(".MyEned span.wiI7pd");
      let currentText = textEl ? textEl.textContent.trim() : "";
      let reviewTextOriginal = currentText;
      let reviewTextTranslated = "";

      // We do not auto-click translate button while scrolling rapidly as it causes huge delays and DOM shifting
      // We just extract the text as-is to speed up incremental checking.
      if (name !== "Unknown" && rawDate !== "") {
        results.push({
          reviewerName: name,
          profilePhoto: profilePhoto,
          profileLink: profileLink,
          dateOfReviewRaw: rawDate,
          rating: rating,
          reviewTextOriginal: reviewTextOriginal,
          reviewTextTranslated: reviewTextTranslated,
        });
      }
    }
    return results;
  });
}

// -------------------------------------------------------------
// Scheduler Setup
// -------------------------------------------------------------

console.log("Starting Incremental Google Review Scraper Background Process...");
console.log(
  "The scraper will run immediately upon startup, and then every 3 days.",
);

// Run once on startup
scrapeGoogleMapsReviewsIncremental();

// Setup Cron Job: '0 0 */3 * *' -> Run at 00:00 every 3rd day of the month '*/2 * * * *'
cron.schedule("*/6 * * * *", () => {
  console.log(`\n\n--- Cron Triggered at ${new Date().toISOString()} ---`);
  scrapeGoogleMapsReviewsIncremental();
});
