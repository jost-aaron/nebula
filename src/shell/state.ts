export interface ShellState {
  focusedAppId: string;
  detailAppId: string | null;
  activeAppId: string | null;
}

export type ShellTransition =
  | { type: "move"; delta: -1 | 1 }
  | { type: "select"; appId: string }
  | { type: "show-details" }
  | { type: "activate" }
  | { type: "close-detail" }
  | { type: "close-active" };

export const clampAppIndex = (index: number, appIds: readonly string[]) =>
  Math.max(0, Math.min(index, Math.max(0, appIds.length - 1)));

export const createShellState = (appIds: readonly string[], focusedAppId?: string | null): ShellState => {
  if (appIds.length === 0) {
    throw new Error("The dashboard shell requires at least one app.");
  }

  return {
    focusedAppId: focusedAppId && appIds.includes(focusedAppId) ? focusedAppId : appIds[0],
    detailAppId: null,
    activeAppId: null
  };
};

export const transitionShellState = (
  state: ShellState,
  transition: ShellTransition,
  appIds: readonly string[]
): ShellState => {
  if (appIds.length === 0) {
    return state;
  }

  if (transition.type === "move") {
    const currentIndex = Math.max(0, appIds.indexOf(state.focusedAppId));
    return { ...state, focusedAppId: appIds[clampAppIndex(currentIndex + transition.delta, appIds)] };
  }

  if (transition.type === "select") {
    return appIds.includes(transition.appId) ? { ...state, focusedAppId: transition.appId } : state;
  }

  if (transition.type === "show-details") {
    return { ...state, detailAppId: state.focusedAppId, activeAppId: null };
  }

  if (transition.type === "activate") {
    return { ...state, activeAppId: state.focusedAppId, detailAppId: null };
  }

  if (transition.type === "close-detail") {
    return { ...state, detailAppId: null };
  }

  return { ...state, activeAppId: null };
};
