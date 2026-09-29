import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, type SelectItem, Text } from "@earendil-works/pi-tui";

export const MAX_VISIBLE_SELECT_ITEMS = 10;

export async function selectScrollableOption(
	ctx: ExtensionContext,
	title: string,
	options: string[],
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		return ctx.ui.select(title, options);
	}
	const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const items: SelectItem[] = options.map((option) => ({ value: option, label: option }));
		const selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE_SELECT_ITEMS), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("border", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`↑↓ navigate • enter select • esc cancel • ${MAX_VISIBLE_SELECT_ITEMS} visible`,
				),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("border", str)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result ?? undefined;
}
