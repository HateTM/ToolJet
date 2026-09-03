import React from 'react';
import PropTypes from 'prop-types';
import FileList from './FileList';

const fileListDefaultProps = {
  type: 'single',
  onRemove: () => {},
  width: '300px',
  onRetry: () => {},
};

const FileListComponent = (rawProps) => {
  const props = { ...fileListDefaultProps, ...rawProps };
  return <FileList {...props} />;
};

export default FileListComponent;

FileListComponent.propTypes = {
  type: PropTypes.oneOf(['single', 'multiple']),
  files: PropTypes.array,
  onRemove: PropTypes.func,
  width: PropTypes.string,
  onRetry: PropTypes.func,
};
