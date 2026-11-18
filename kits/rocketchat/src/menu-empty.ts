// The empty-menu rule of the composer's "+" (More actions), M12 X4 (D41, ruling FN5). Pure, so a unit test reads it.
// Rocket.Chat's `GenericMenu` has its own empty rule, but it counts the SECTIONS (`sections.length > 0`), and the composer
// always passes its "Create new" and "Share" sections, so a menu with no item in them still renders a "+" that opens two
// bare titles. The kit counts the ITEMS across the sections (or the flat `items`).
type Counted = { sections?: readonly { items?: readonly unknown[] }[]; items?: readonly unknown[] };

/** The items a menu would list: the truthy entries across its sections, or its flat `items`. */
export const menuItemCount = (menu: Counted): number => {
	const lists = menu.sections ? menu.sections.map((section) => section.items ?? []) : [menu.items ?? []];
	return lists.reduce((total, items) => total + items.filter(Boolean).length, 0);
};

/** True while the menu lists no item: the kit shows no button for it. */
export const isMenuWithoutItem = (menu: Counted): boolean => menuItemCount(menu) === 0;
