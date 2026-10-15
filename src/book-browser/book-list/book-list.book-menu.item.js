// Native action buttons shared by the lorebook menu and optional integrations.

export const createBookMenuActionItem = ({
  itemClass,
  iconClass,
  labelText,
  onClick,
  attributes = {},
}) => {
  const item = document.createElement('button');
  item.type = 'button';
  item.classList.add('stwid--list-dropdown__item', 'stwid--menu-item', itemClass);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      item.setAttribute(key, value);
    }
  }
  item.addEventListener('click', onClick);

  const itemIcon = document.createElement('i');
  itemIcon.setAttribute('aria-hidden', 'true');
  itemIcon.classList.add('stwid--icon', 'fa-solid', 'fa-fw', iconClass);
  item.append(itemIcon);

  const menuLabel = document.createElement('span');
  menuLabel.classList.add('stwid--label');
  menuLabel.textContent = labelText;
  item.append(menuLabel);

  return item;
};
