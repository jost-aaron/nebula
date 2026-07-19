import { createElement, icons } from "lucide";
import type { DashboardApp } from "./apps";

const iconMarkup = (iconName: string, className: string) => {
  const iconNode = icons[iconName as keyof typeof icons] ?? icons.Square;
  const node = createElement(iconNode);
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node.outerHTML;
};

const cinemaIconMarkup = (className: string) => `
  <svg class="${className} cinema-app-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <path d="M128 22c38 0 74 18 96 48-29-11-61-8-86 7-23 14-39 37-45 63-12-41 1-86 35-118Z" />
    <path d="M128 22c38 0 74 18 96 48-29-11-61-8-86 7-23 14-39 37-45 63-12-41 1-86 35-118Z" transform="rotate(72 128 128)" />
    <path d="M128 22c38 0 74 18 96 48-29-11-61-8-86 7-23 14-39 37-45 63-12-41 1-86 35-118Z" transform="rotate(144 128 128)" />
    <path d="M128 22c38 0 74 18 96 48-29-11-61-8-86 7-23 14-39 37-45 63-12-41 1-86 35-118Z" transform="rotate(216 128 128)" />
    <path d="M128 22c38 0 74 18 96 48-29-11-61-8-86 7-23 14-39 37-45 63-12-41 1-86 35-118Z" transform="rotate(288 128 128)" />
    <path class="cinema-app-icon-cutout" d="M103 78c0-8 9-13 16-8l69 49c7 5 7 15 0 20l-69 49c-7 5-16 0-16-8V78Z" />
    <path d="m226 107 4 13 13 4-13 4-4 13-4-13-13-4 13-4 4-13Z" />
  </svg>
`;

export const renderAppIcon = (app: DashboardApp, className = "app-icon") =>
  app.id === "cinema"
    ? cinemaIconMarkup(className)
    : iconMarkup(app.icon, className);
