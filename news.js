(function loadNewsArticles() {
  const articles = window.DAILY_DOOMSAYER_ARTICLES;

  if (!Array.isArray(articles) || articles.length === 0) {
    return;
  }

  const featuredArticle = articles.find((article) => article.featured);

  if (featuredArticle) {
    const headlineLink = document.querySelector("#headline-link");
    const headlineTitle = document.querySelector("#headline-title");

    if (headlineLink && headlineTitle) {
      headlineLink.href = featuredArticle.url;
      headlineTitle.textContent = featuredArticle.title;
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

    links.forEach((link, linkIndex) => {
      const article = groupArticles[startIndex + linkIndex];

      if (!article) {
        return;
      }

      link.textContent = article.title;
      link.href = article.url;
    });

    groupCursors.set(group, startIndex + links.length);
  });
})();
