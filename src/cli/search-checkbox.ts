import {
  createPrompt,
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isUpKey,
  makeTheme,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState,
  type Theme,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import figures from "@inquirer/figures";
import pc from "picocolors";

export interface SearchCheckboxChoice<Value> {
  name: string;
  value: Value;
  description?: string;
  disabled?: boolean | string;
  checked?: boolean;
  category?: string | null;
}

export interface SearchCheckboxConfig<Value> {
  message: string;
  choices: readonly SearchCheckboxChoice<Value>[];
  pageSize?: number;
  required?: boolean;
  validate?: (choices: ReadonlyArray<Value>) => boolean | string | Promise<boolean | string>;
  theme?: Partial<Theme>;
}

export const searchCheckbox = createPrompt(
  <Value>(config: SearchCheckboxConfig<Value>, done: (value: Value[]) => void) => {
    const { pageSize = 15, required = false, validate = () => true } = config;
    const theme = makeTheme(config.theme);
    const [status, setStatus] = useState<"idle" | "done">("idle");
    const prefix = usePrefix({ status, theme });

    const [searchTerm, setSearchTerm] = useState("");
    const [checkedSet, setCheckedSet] = useState<Set<Value>>(() => {
      const initial = new Set<Value>();
      for (const c of config.choices) {
        if (c.checked) initial.add(c.value);
      }
      return initial;
    });

    const [errorMsg, setError] = useState<string | undefined>();

    // Filter choices based on searchTerm
    const filteredChoices = useMemo(() => {
      const query = searchTerm.trim().toLowerCase();
      const list = query
        ? config.choices.filter((choice) => choice.name.toLowerCase().includes(query))
        : config.choices;

      return list.map((choice) => ({
        ...choice,
        checked: checkedSet.has(choice.value),
      }));
    }, [searchTerm, checkedSet, config.choices]);

    const [active, setActive] = useState(0);

    useKeypress(async (key) => {
      if (errorMsg) {
        setError(undefined);
      }

      if (isEnterKey(key)) {
        const selectedValues = Array.from(checkedSet);
        if (required && selectedValues.length === 0) {
          setError("At least one group must be selected.");
          return;
        }

        const isValid = await validate(selectedValues);
        if (isValid === true) {
          setStatus("done");
          done(selectedValues);
        } else {
          setError(typeof isValid === "string" ? isValid : "You must select a valid choice.");
        }
      } else if (isUpKey(key) || isDownKey(key)) {
        if (filteredChoices.length === 0) return;
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        const count = filteredChoices.length;
        do {
          next = (next + offset + count) % count;
        } while (filteredChoices[next]?.disabled && next !== active);
        setActive(next);
      } else if (isSpaceKey(key)) {
        if (filteredChoices.length === 0) return;
        const current = filteredChoices[active];
        if (current) {
          if (current.disabled) {
            setError(typeof current.disabled === "string" ? current.disabled : "This item is disabled.");
          } else {
            const nextSet = new Set(checkedSet);
            if (nextSet.has(current.value)) {
              nextSet.delete(current.value);
            } else {
              nextSet.add(current.value);
            }
            setCheckedSet(nextSet);
          }
        }
      } else if (key.ctrl && key.name === "a") {
        // Ctrl+A: Toggle all filtered choices
        const enabledChoices = filteredChoices.filter((c) => !c.disabled);
        const allVisibleChecked = enabledChoices.every((c) => checkedSet.has(c.value));
        const nextSet = new Set(checkedSet);

        if (allVisibleChecked) {
          // Uncheck all visible
          for (const c of enabledChoices) {
            nextSet.delete(c.value);
          }
        } else {
          // Check all visible
          for (const c of enabledChoices) {
            nextSet.add(c.value);
          }
        }
        setCheckedSet(nextSet);
      } else if ((key.ctrl && key.name === "c") || key.name === "tab") {
        // Toggle all groups in the active item's community/category
        const current = filteredChoices[active];
        if (current && current.category) {
          const categoryChoices = filteredChoices.filter(
            (c) => c.category === current.category && !c.disabled
          );
          const allCommunityChecked = categoryChoices.every((c) => checkedSet.has(c.value));
          const nextSet = new Set(checkedSet);

          if (allCommunityChecked) {
            for (const c of categoryChoices) {
              nextSet.delete(c.value);
            }
          } else {
            for (const c of categoryChoices) {
              nextSet.add(c.value);
            }
          }
          setCheckedSet(nextSet);
        }
      } else if (isBackspaceKey(key)) {
        if (searchTerm.length > 0) {
          setSearchTerm(searchTerm.slice(0, -1));
          setActive(0);
        }
      } else if (!key.ctrl && key.name !== "tab" && key.name !== "escape") {
        const char =
          "sequence" in key && typeof key.sequence === "string"
            ? key.sequence
            : (key.name?.length === 1 ? key.name : "");
        if (char && char.length === 1 && char >= " ") {
          setSearchTerm(searchTerm + char);
          setActive(0);
        }
      }
    });

    const message = theme.style.message(config.message, status);

    if (status === "done") {
      const selectedNames = config.choices
        .filter((c) => checkedSet.has(c.value))
        .map((c) => c.name);
      const answer = theme.style.answer(
        selectedNames.length > 0
          ? `${selectedNames.length} selected (${selectedNames.slice(0, 3).join(", ")}${selectedNames.length > 3 ? ", ..." : ""})`
          : "None"
      );
      return [prefix, message, answer].filter(Boolean).join(" ");
    }

    let pageOutput: string;
    if (filteredChoices.length === 0) {
      pageOutput = pc.yellow(`  No groups found matching "${searchTerm}". (Press Backspace to clear search)`);
    } else {
      pageOutput = usePagination({
        items: filteredChoices,
        active,
        pageSize,
        loop: true,
        renderItem({ item, isActive, index }) {
          const cursor = isActive ? pc.cyan(figures.pointer) : " ";
          const checkbox = item.checked ? pc.green(figures.circleFilled) : pc.dim(figures.circle);
          const label = isActive ? pc.cyan(pc.bold(item.name)) : item.name;

          // Check if this item starts a new community category
          const prevItem = index > 0 ? filteredChoices[index - 1] : undefined;
          const isNewCategory = prevItem && prevItem.category !== item.category;

          const separator = isNewCategory
            ? `${pc.dim("  ───────────────────────────────────────────────────────────")}\n`
            : "";

          return `${separator}${cursor} ${checkbox} ${label}`;
        },
      });
    }

    const selectedBadge = pc.green(
      `[${checkedSet.size} selected]`
    );

    const searchDisplay = searchTerm
      ? `${pc.dim("Search:")} ${pc.bold(pc.yellow(searchTerm))}`
      : pc.dim("(type to search live...)");

    const helpLine = pc.dim(
      `${pc.bold("↑↓")} navigate • ${pc.bold("space")} check • ${pc.bold("tab")} toggle community • ${pc.bold("ctrl+a")} toggle all • ${pc.bold("type")} search • ${pc.bold("⏎")} proceed`
    );

    const lines = [
      `${prefix} ${message} ${selectedBadge} ${searchDisplay}`,
      "",
      pageOutput,
      "",
      errorMsg ? pc.red(errorMsg) + "\n" : "",
      helpLine,
    ]
      .filter((line) => line !== undefined)
      .join("\n")
      .trimEnd();

    return `${lines}${cursorHide}`;
  }
);
