import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  await page
    .evaluate(async () => {
      const csrf = localStorage.getItem("hunter-e2e-csrf") ?? "";
      await fetch("/__e2e_shutdown", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-hunter-e2e-csrf": csrf },
      });
    })
    .catch(() => undefined);
});

test("需求到归档知识的故事只在首个未接线 Run 转换处 RED", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("项目名称").fill("Hunter E2E");
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByText("项目已创建")).toBeVisible();
  await page.getByRole("button", { name: "重新检查授权" }).click();
  await page.getByRole("button", { name: "打开 Hunter E2E" }).click();

  await page.getByLabel("需求标题").fill("移动审批");
  await page.getByLabel("需求正文").fill("可信设备批准后恢复同一 Run");
  await page.getByLabel("验收标准").fill("手机批准后恢复 Run");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "批准此版本" }).click();
  await expect(page.getByText("此版本已批准且不可修改")).toBeVisible();

  await page.getByRole("button", { name: "使用并行交付模板" }).click();
  await page.getByRole("button", { name: "确认执行计划" }).click();
  await expect(page.getByText(/执行计划已发布：epl_/u)).toBeVisible();
  await page
    .getByRole("button", { name: "启动工作流（测试契约）" })
    .click();

  const projectPosition = page.getByTestId("project-created-position");
  const approvalPosition = page.getByTestId(
    "requirement-approved-position",
  );
  await expect(projectPosition).toHaveText(/^[1-9]\d*$/u);
  await expect(approvalPosition).toHaveText(/^[1-9]\d*$/u);
  await expect(page.getByText("RUN_COMPOSITION_NOT_WIRED")).toBeVisible();

  const projectPositionText = await projectPosition.textContent();
  const approvalPositionText = await approvalPosition.textContent();
  expect(
    await page.getByText("执行：已返回 · 验证：失败").isVisible(),
    `RUN_COMPOSITION_NOT_WIRED; ProjectCreated ledger position=${projectPositionText}; RequirementRevisionApproved ledger position=${approvalPositionText}`,
  ).toBe(true);
});
