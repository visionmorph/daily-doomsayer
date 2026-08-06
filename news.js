(function loadNewsArticles() {
  const articles = window.DAILY_DOOMSAYER_ARTICLES;
  const site = window.DAILY_DOOMSAYER_SITE || {};
  const severityScale = site.doomIndex?.severityScale || [];
  let glitchImageIndex = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  document.querySelectorAll("a.news-link").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

  function dateKeyInTimeZone(date, timeZone) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );

    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function dateKeyAsUtcMilliseconds(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  }

  function romanNumeral(value) {
    if (!Number.isInteger(value) || value < 1 || value > 3999) {
      return String(value);
    }

    const numerals = [
      [1000, "M"],
      [900, "CM"],
      [500, "D"],
      [400, "CD"],
      [100, "C"],
      [90, "XC"],
      [50, "L"],
      [40, "XL"],
      [10, "X"],
      [9, "IX"],
      [5, "V"],
      [4, "IV"],
      [1, "I"],
    ];
    let remainder = value;
    let result = "";

    for (const [amount, numeral] of numerals) {
      while (remainder >= amount) {
        result += numeral;
        remainder -= amount;
      }
    }

    return result;
  }

  function updateChronicleNumber() {
    const numberElement = document.querySelector("#chronicle-number");
    const trackingStartedOn = site.chronicle?.trackingStartedOn;
    const timeZone = site.chronicle?.timeZone || "America/Chicago";

    if (!numberElement || !/^\d{4}-\d{2}-\d{2}$/.test(trackingStartedOn || "")) {
      return;
    }

    const today = dateKeyInTimeZone(new Date(), timeZone);
    const elapsedDays = Math.floor(
      (dateKeyAsUtcMilliseconds(today) -
        dateKeyAsUtcMilliseconds(trackingStartedOn)) /
        86_400_000,
    );
    const edition = Math.max(1, elapsedDays + 1);
    const roman = romanNumeral(edition);
    const numerical = String(edition);

    numberElement.dataset.roman = roman;
    numberElement.dataset.numerical = numerical;
    numberElement.textContent =
      numberElement.matches(":hover") || document.activeElement === numberElement
        ? numerical
        : roman;
    numberElement.setAttribute("aria-label", numerical);
    numberElement.title = numerical;
  }

  function initializeChronicle() {
    const numberElement = document.querySelector("#chronicle-number");

    if (!numberElement) {
      return;
    }

    const showNumerical = () => {
      numberElement.textContent = numberElement.dataset.numerical || "1";
    };
    const showRoman = () => {
      numberElement.textContent = numberElement.dataset.roman || "I";
    };

    updateChronicleNumber();
    numberElement.addEventListener("mouseenter", showNumerical);
    numberElement.addEventListener("mouseleave", showRoman);
    numberElement.addEventListener("focus", showNumerical);
    numberElement.addEventListener("blur", showRoman);
    window.setInterval(updateChronicleNumber, 60_000);
  }

  function formattedMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : "—";
  }

  function formattedChange(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
      return "—";
    }

    if (number > 0) {
      return `▲${number.toFixed(2)}`;
    }

    if (number < 0) {
      return `▼${Math.abs(number).toFixed(2)}`;
    }

    return "0.00";
  }

  function initializeMarketTape() {
    const tickerTrack = document.querySelector("#ticker-track");
    const intraday = site.intradayDoom || {};

    if (!tickerTrack || tickerTrack.children.length < 2) {
      return;
    }

    const tickers = [
      `[DOOM NOW ${formattedMetric(intraday.current)}]`,
      `[LAST HOUR ${formattedChange(intraday.lastHourChange)}]`,
      `[OPEN ${formattedMetric(intraday.open)}]`,
      `[DAY CHANGE ${formattedChange(intraday.dayChange)}]`,
      `[PEAK DOOM ${formattedMetric(intraday.peak)}]`,
    ];
    let tickerIndex = 0;

    tickerTrack.children[0].textContent = tickers[0];
    tickerTrack.children[1].textContent = tickers[1];

    window.setInterval(() => {
      tickerTrack.classList.add("ticker-track--moving");

      window.setTimeout(() => {
        tickerIndex = (tickerIndex + 1) % tickers.length;
        const nextIndex = (tickerIndex + 1) % tickers.length;
        tickerTrack.classList.remove("ticker-track--moving");
        tickerTrack.children[0].textContent = tickers[tickerIndex];
        tickerTrack.children[1].textContent = tickers[nextIndex];
      }, 600);
    }, 4000);
  }

  function renderDoomIndexLegend() {
    const versionElement = document.querySelector("#doom-index-legend-version");
    const scaleElement = document.querySelector("#doom-index-legend-scale");

    if (versionElement) {
      versionElement.textContent = `Doom Index ${site.doomIndex?.version || ""}`.trim();
    }

    if (!scaleElement || severityScale.length === 0) {
      return;
    }

    scaleElement.replaceChildren();

    for (const band of severityScale) {
      const item = document.createElement("div");
      item.className = "doom-index-legend-band";
      item.textContent = `${Number(band.minimum).toFixed(2)}–${Number(
        band.maximum,
      ).toFixed(2)} ${band.label}: ${band.description}`;
      scaleElement.append(item);
    }
  }

  function renderSourceDirectory() {
    const directoryElement = document.querySelector("#source-directory");

    if (!directoryElement || !Array.isArray(site.sources)) {
      return;
    }

    directoryElement.replaceChildren();

    for (const source of site.sources) {
      const link = document.createElement("a");
      link.className = "news-link";
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.name;
      directoryElement.append(link);
    }
  }

  initializeChronicle();
  initializeMarketTape();
  renderDoomIndexLegend();
  renderSourceDirectory();

  function doomIndexValue(article) {
    const recordedDoomIndex = Number(article?.doomIndex);

    if (Number.isFinite(recordedDoomIndex)) {
      return Math.max(0, Math.min(recordedDoomIndex, 100));
    }

    const score = Number(article?.score);

    if (!Number.isFinite(score)) {
      return null;
    }

    return Math.max(0, Math.min(score * 100, 100));
  }

  function doomClassification(value) {
    return (
      severityScale.find(
        (band) => value >= Number(band.minimum) && value <= Number(band.maximum),
      )?.label || "UNCLASSIFIED"
    );
  }

  function compactDoomIndex(article) {
    const value = doomIndexValue(article);
    return value === null ? "" : `[${value.toFixed(2)}]`;
  }

  function fullDoomIndex(article) {
    const value = doomIndexValue(article);

    return value === null
      ? ""
      : `[DOOM INDEX ${value.toFixed(2)}/${doomClassification(value)}]`;
  }

  function randomInteger(minimum, maximum) {
    return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
  }

  function applyRandomGlitch(layer, maximumOffset, shouldScale) {
    const sliceTop = randomInteger(0, 88);
    const sliceHeight = randomInteger(3, Math.min(28, 100 - sliceTop));
    const sliceBottom = Math.max(0, 100 - sliceTop - sliceHeight);
    const horizontalOffset = randomInteger(-maximumOffset, maximumOffset);
    const scale = shouldScale
      ? (Math.random() * (1.1 - 0.9) + 0.9).toFixed(2)
      : 1;

    layer.style.clipPath = `inset(${sliceTop}% 0 ${sliceBottom}% 0)`;
    layer.style.transform = `translateX(${horizontalOffset}px) scale(${scale})`;
  }

  function startGlitchLoop(
    container,
    layer,
    { minimumTime, maximumTime, maximumOffset, shouldScale, initialDelay },
  ) {
    function updateLayer() {
      if (!container.isConnected) {
        return;
      }

      if (reducedMotion.matches) {
        layer.style.clipPath = "inset(100% 0 0 0)";
        layer.style.transform = "none";
      } else {
        applyRandomGlitch(layer, maximumOffset, shouldScale);
      }

      window.setTimeout(
        updateLayer,
        reducedMotion.matches
          ? 1000
          : randomInteger(minimumTime, maximumTime),
      );
    }

    window.setTimeout(updateLayer, initialDelay);
  }

  function addGlitchLayers(container, image) {
    if (!container || !image || container.querySelector(".glitch-image-layer")) {
      return;
    }

    const imageIndex = glitchImageIndex;
    glitchImageIndex += 1;

    image.classList.add("story-image-base");

    const layerSettings = [
      {
        name: "first",
        minimumTime: 10,
        maximumTime: 100,
        maximumOffset: 16,
        shouldScale: false,
      },
      {
        name: "second",
        minimumTime: 10,
        maximumTime: 300,
        maximumOffset: 40,
        shouldScale: true,
      },
      {
        name: "blend",
        minimumTime: 10,
        maximumTime: 300,
        maximumOffset: 40,
        shouldScale: true,
      },
    ];

    layerSettings.forEach((settings, layerIndex) => {
      const layer = image.cloneNode(false);

      layer.removeAttribute("id");
      layer.removeAttribute("hidden");
      layer.alt = "";
      layer.setAttribute("aria-hidden", "true");
      layer.classList.remove("story-image-base");
      layer.classList.add(
        "glitch-image-layer",
        `glitch-image-layer--${settings.name}`,
      );
      container.append(layer);

      startGlitchLoop(container, layer, {
        ...settings,
        initialDelay:
          ((imageIndex + 1) * (layerIndex + 1) * 73) % settings.maximumTime,
      });
    });
  }

  if (!Array.isArray(articles) || articles.length === 0) {
    return;
  }

  const featuredArticle = articles.find((article) => article.featured);

  if (featuredArticle) {
    const headlineLink = document.querySelector("#headline-link");
    const headlineTitle = document.querySelector("#headline-title");
    const headlineDoomIndex = document.querySelector("#headline-doom-index");
    const headlineImageLink = document.querySelector("#headline-image-link");
    const headlineImage = document.querySelector("#headline-image");
    const headlineImagePlaceholder = document.querySelector(
      "#headline-image-placeholder",
    );

    if (headlineLink && headlineTitle) {
      headlineLink.href = featuredArticle.url;
      headlineTitle.textContent = featuredArticle.title;
    }

    if (headlineDoomIndex) {
      headlineDoomIndex.textContent = fullDoomIndex(featuredArticle);
    }

    if (headlineImageLink) {
      headlineImageLink.href = featuredArticle.url;
    }

    if (featuredArticle.image && headlineImage) {
      headlineImage.src = featuredArticle.image;
      headlineImage.alt = featuredArticle.title;
      headlineImage.hidden = false;
      headlineImageLink?.classList.add("has-story-image");
      addGlitchLayers(headlineImageLink, headlineImage);

      if (headlineImagePlaceholder) {
        headlineImagePlaceholder.hidden = true;
      }
    }
  }

  const articlesByGroup = new Map();

  for (const article of articles) {
    if (article.featured) {
      continue;
    }

    if (!articlesByGroup.has(article.group)) {
      articlesByGroup.set(article.group, []);
    }

    articlesByGroup.get(article.group).push(article);
  }

  const groupCursors = new Map();

  document.querySelectorAll("[data-news-group]").forEach((groupElement) => {
    const group = groupElement.dataset.newsGroup;
    const groupArticles = articlesByGroup.get(group) || [];
    const links = groupElement.querySelectorAll("a.news-link");
    const startIndex = groupCursors.get(group) || 0;
    const coverArticle = groupArticles[startIndex];

    if (
      coverArticle?.image &&
      !groupElement.parentElement.querySelector(".news-category-cover-link")
    ) {
      const coverLink = document.createElement("a");
      const coverImage = document.createElement("img");

      coverLink.className =
        "news-category-cover-link story-image-link has-story-image";
      coverLink.href = coverArticle.url;
      coverLink.target = "_blank";
      coverLink.rel = "noopener noreferrer";

      coverImage.className = "news-category-cover";
      coverImage.src = coverArticle.image;
      coverImage.alt = coverArticle.title;
      coverImage.loading = "lazy";

      coverLink.append(coverImage);
      addGlitchLayers(coverLink, coverImage);
      groupElement.parentElement.insertBefore(coverLink, groupElement);
    }

    links.forEach((link, linkIndex) => {
      const article = groupArticles[startIndex + linkIndex];

      if (!article) {
        return;
      }

      const doomIndex = compactDoomIndex(article);
      link.textContent = doomIndex
        ? `${article.title} ${doomIndex}`
        : article.title;
      link.href = article.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });

    groupCursors.set(group, startIndex + links.length);
  });
})();
