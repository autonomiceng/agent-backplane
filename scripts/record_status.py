#!/usr/bin/env python3
"""Prepare status directories or record one verified bootstrap outcome."""

import argparse
import sys
from pathlib import Path

from status_io import Unavailable, directory, task_record
from status_config import selection


def prepare(state_dir):
    with directory(state_dir / 'status', 0o700):
        pass
    with directory(state_dir / 'console', 0o755):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--checkout', type=Path)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--started')
    parser.add_argument('--project-name')
    parser.add_argument('--compose-file', action='append')
    parser.add_argument('--profile', action='append')
    parser.add_argument('--state', choices=('healthy', 'unavailable'))
    args = parser.parse_args()
    try:
        prepare(args.state_dir)
        record = (args.checkout, args.env_file, args.started, args.state)
        if args.prepare:
            if any(value is not None for value in (*record, args.project_name, args.compose_file, args.profile)):
                raise Unavailable()
        elif any(value is None for value in record):
            raise Unavailable()
        else:
            root, env_file, project, files, profiles = selection(
                args.checkout, args.env_file, args.project_name, args.compose_file or (), args.profile)
            task_record(args.state_dir, root, env_file, args.started, args.state,
                        {'project': project, 'composeFiles': list(map(str, files)), 'profiles': list(profiles)})
    except Unavailable:
        print('status_path_unsafe', file=sys.stderr)
        return 1
    except (OSError, UnicodeError):
        print('status_path_unavailable', file=sys.stderr)
        return 1
    except ValueError:
        print('status_record_invalid', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
