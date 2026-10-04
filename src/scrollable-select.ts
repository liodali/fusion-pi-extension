import {
	DynamicBorder,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	Text,
} from "@earendil-works/pi-tui";

export const MAX_VISIBLE_SELECT_ITEMS = 10;

function selectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

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
		const selectList = new SelectList(
			items,
			Math.min(items.length, MAX_VISIBLE_SELECT_ITEMS),
			selectListTheme(theme),
		);
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

export async function selectSearchableOption(
	ctx: ExtensionContext,
	title: string,
	filter: (query: string) => string[],
	options?: { placeholder?: string },
): Promise<string | undefined> {
	const placeholder = options?.placeholder ?? "Type to search";
	if (ctx.mode !== "tui") {
		const query = await ctx.ui.input(title, placeholder);
		if (query === undefined) return undefined;
		const choices = filter(query);
		if (choices.length === 0) return undefined;
		return ctx.ui.select(title, choices);
	}
	const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const input = new Input({
			placeholder,
			placeholderStyle: (text) => theme.fg("muted", text),
		});
		input.focused = true;

		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("border", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(input);
		const listSlot = container.children.length;

		let selectList: SelectList | undefined;
		const buildListChild = (): SelectList | Text => {
			const items: SelectItem[] = filter(input.getValue()).map((option) => ({
				value: option,
				label: option,
			}));
			if (items.length === 0) {
				selectList = undefined;
				return new Text(theme.fg("warning", "No models match"), 1, 0);
			}
			const list = new SelectList(
				items,
				Math.max(1, Math.min(items.length, MAX_VISIBLE_SELECT_ITEMS)),
				selectListTheme(theme),
			);
			list.onSelect = (item) => done(item.value);
			selectList = list;
			return list;
		};

		container.addChild(buildListChild());
		container.addChild(
			new Text(
				theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("border", str)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm")
				) {
					selectList?.handleInput(data);
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				} else {
					const before = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== before) {
						container.children[listSlot] = buildListChild();
					}
				}
				tui.requestRender();
			},
		};
	});
	return result ?? undefined;
}
