import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { expectNoHorizontalOverflow, MEMBER, openApp, OWNER } from "./helpers";

const openDirect = async (page: Page, displayName: string) => {
  await page.getByRole("button", { name: "Start a conversation" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Message someone" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Search enabled accounts").fill(displayName);
  const account = dialog.locator("[data-party-user]", { hasText: displayName });
  await expect(account).toBeVisible();
  await account.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-party-composer]")).toBeVisible();
};

const sendMessage = async (page: Page, text: string) => {
  const composer = page.locator("[data-party-message-input]");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator("[data-party-messages]")).toContainText(text);
};

test("Party owner/member DM, attachment, group, and mobile flow", async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const suffix = `${Date.now().toString(36)}-${testInfo.parallelIndex}`;
  const memberText = `Party hello ${suffix}`;
  const ownerText = `Party reply ${suffix}`;
  const groupTitle = `E2E crew ${suffix}`;
  const attachmentName = `party-note-${suffix}.txt`;
  const attachmentBody = `Nebula Party attachment ${suffix}\n`;

  const memberContext = await browser.newContext({
    storageState: "test-results/auth/member.json"
  });
  const memberPage = await memberContext.newPage();
  testInfo.attachments.push({
    name: "party-scenario",
    body: Buffer.from(`suffix=${suffix}`),
    contentType: "text/plain"
  });

  try {
    await openApp(memberPage, "Party");
    await expect(memberPage.locator("[data-party-connection]")).toContainText(/Live|Reconnecting/);
    await openDirect(memberPage, OWNER.displayName);
    await sendMessage(memberPage, memberText);

    await openApp(page, "Party");
    const ownerConversation = page.locator("[data-party-conversation]", { hasText: MEMBER.displayName });
    await expect(ownerConversation).toBeVisible();
    await ownerConversation.click();
    await expect(page.locator("[data-party-messages]")).toContainText(memberText);
    await sendMessage(page, ownerText);
    await expect(memberPage.locator("[data-party-messages]")).toContainText(ownerText);

    await memberPage.locator("[data-party-file]").setInputFiles({
      buffer: Buffer.from(attachmentBody),
      mimeType: "text/plain",
      name: attachmentName
    });
    const memberDownload = memberPage.getByRole("button", { name: `Download ${attachmentName}` });
    await expect(memberDownload).toBeVisible();
    const ownerDownload = page.getByRole("button", { name: `Download ${attachmentName}` });
    await expect(ownerDownload).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await ownerDownload.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(attachmentName);
    expect(await readFile(await download.path(), "utf8")).toBe(attachmentBody);

    await memberPage.getByRole("button", { name: "Start a conversation" }).first().click();
    const groupDialog = memberPage.getByRole("dialog", { name: "Message someone" });
    await groupDialog.getByRole("tab", { name: "Group" }).click();
    const groupCreateDialog = memberPage.getByRole("dialog", { name: "Create a group" });
    await groupCreateDialog.getByLabel("Group title").fill(groupTitle);
    await groupCreateDialog.getByPlaceholder("Search enabled accounts").fill(OWNER.displayName);
    const ownerResult = groupCreateDialog.locator("[data-party-user]", { hasText: OWNER.displayName });
    await expect(ownerResult).toBeVisible();
    await ownerResult.click();
    await groupCreateDialog.getByRole("button", { name: "Create group" }).click();
    await expect(groupCreateDialog).toBeHidden();
    await expect(memberPage.locator("[data-party-thread-header]")).toContainText(groupTitle);
    await memberPage.getByRole("button", { name: "Manage group" }).click();
    const manageGroupDialog = memberPage.getByRole("dialog", { name: "Manage group" });
    await expect(manageGroupDialog).toContainText(OWNER.displayName);
    await memberPage.keyboard.press("Escape");
    await expect(manageGroupDialog).toBeHidden();

    await memberPage.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(memberPage);
    await expect(memberPage.getByRole("button", { name: "Back to conversations" })).toBeVisible();
    await memberPage.getByRole("button", { name: "Back to conversations" }).click();
    await expect(memberPage.locator("[data-party-conversations]")).toBeVisible();
    await expectNoHorizontalOverflow(memberPage);

    await memberPage.keyboard.press("Escape");
    await expect(memberPage.locator("#app-surface")).toBeHidden();
  } finally {
    await memberContext.close();
  }
});
