(function loadNewsArticles() {
  const articles = window.DAILY_DOOMSAYER_ARTICLES;
  let glitchImageIndex = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  document.querySelectorAll("a.news-link").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

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
    if (value < 20) return "UNEASY";
    if (value < 40) return "OMINOUS";
    if (value < 60) return "ALARMING";
    if (value < 80) return "DIRE";
    return "CATASTROPHIC";
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
