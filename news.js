(function loadNewsArticles() {
  const articles = window.DAILY_DOOMSAYER_ARTICLES;

  if (!Array.isArray(articles) || articles.length === 0) {
    return;
  }

  const articlesByGroup = new Map();

  for (const article of articles) {
    if (!articlesByGroup.has(article.group)) {
      articlesByGroup.set(article.group, []);
    }

    articlesByGroup.get(article.group).push(article);
  }

  document.querySelectorAll("[data-news-group]").forEach((groupElement) => {
    const group = groupElement.dataset.newsGroup;
    const groupArticles = articlesByGroup.get(group) || [];
    const links = groupElement.querySelectorAll("a.news-link");

    links.forEach((link, index) => {
      const article = groupArticles[index];

      if (!article) {
        return;
      }

      link.textContent = article.title;
      link.href = article.url;
    });
  });
})();
