import React from 'react';
import PropTypes from 'prop-types';
import { Switch } from './Switch';

const SwitchComponent = ({
  disabled = false,
  label = '',
  helper = '',
  size = 'default',
  align = 'left',
  required = false,
  className = '',
  ...props
}) => {
  return (
    <Switch
      disabled={disabled}
      label={label}
      helper={helper}
      size={size}
      align={align}
      required={required}
      className={className}
      {...props}
    />
  );
};

export default SwitchComponent;

SwitchComponent.propTypes = {
  checked: PropTypes.bool,
  disabled: PropTypes.bool,
  label: PropTypes.string,
  helper: PropTypes.string,
  size: PropTypes.oneOf(['default', 'large']),
  align: PropTypes.oneOf(['left', 'right']),
  required: PropTypes.bool,
  className: PropTypes.string,
};
