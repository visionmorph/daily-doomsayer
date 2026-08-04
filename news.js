(function loadNewsArticles() {
  const articles = window.DAILY_DOOMSAYER_ARTICLES;
  let glitchImageIndex = 0;

  document.querySelectorAll("a.news-link").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

  function addGlitchLayers(container, image) {
    if (!container || !image || container.querySelector(".glitch-image-layer")) {
      return;
    }

    const imageIndex = glitchImageIndex;
    const baseDuration = 2400 + (imageIndex % 5) * 173;
    const firstLayerDuration = 920 + (imageIndex % 7) * 83;
    const secondLayerDuration = 1370 + (imageIndex % 6) * 127;

    container.style.setProperty("--glitch-base-duration", `${baseDuration}ms`);
    container.style.setProperty(
      "--glitch-layer-one-duration",
      `${firstLayerDuration}ms`,
    );
    container.style.setProperty(
      "--glitch-layer-two-duration",
      `${secondLayerDuration}ms`,
    );
    container.style.setProperty(
      "--glitch-base-delay",
      `${-((imageIndex * 211) % baseDuration)}ms`,
    );
    container.style.setProperty(
      "--glitch-layer-one-delay",
      `${-((imageIndex * 347) % firstLayerDuration)}ms`,
    );
    container.style.setProperty(
      "--glitch-layer-two-delay",
      `${-((imageIndex * 503) % secondLayerDuration)}ms`,
    );
    glitchImageIndex += 1;

    image.classList.add("story-image-base");

    ["top", "bottom"].forEach((position) => {
      const layer = image.cloneNode(false);

      layer.removeAttribute("id");
      layer.removeAttribute("hidden");
      layer.alt = "";
      layer.setAttribute("aria-hidden", "true");
      layer.classList.remove("story-image-base");
      layer.classList.add("glitch-image-layer", `glitch-image-layer--${position}`);
      container.append(layer);
    });
  }

  if (!Array.isArray(articles) || articles.length === 0) {
    return;
  }

  const featuredArticle = articles.find((article) => article.featured);

  if (featuredArticle) {
    const headlineLink = document.querySelector("#headline-link");
    const headlineTitle = document.querySelector("#headline-title");
    const headlineImageLink = document.querySelector("#headline-image-link");
    const headlineImage = document.querySelector("#headline-image");
    const headlineImagePlaceholder = document.querySelector(
      "#headline-image-placeholder",
    );

    if (headlineLink && headlineTitle) {
      headlineLink.href = featuredArticle.url;
      headlineTitle.textContent = featuredArticle.title;
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

      link.textContent = article.title;
      link.href = article.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });

    groupCursors.set(group, startIndex + links.length);
  });
})();
