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

export const renderAppIcon = (app: DashboardApp, className = "app-icon") =>
  iconMarkup(app.icon, className);
