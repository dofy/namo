import { Heading, Text } from '@radix-ui/themes';
import { getLocale } from './i18n';
import type { TaskDetail } from '../src/ui-contract';

interface ContextDetail extends TaskDetail {
  materials?:{state:string;truncated:boolean;nodes:{id:string;name?:string;type:string;state:string;author?:{id?:string;name?:string};error?:string}[];limitations:string[]}[];
  artifacts?:{id:string;path:string;state:string;size?:number;sha256?:string;error?:string}[];
  activity?:{phase:string;updatedAt:number}[];
  progressUpdates?:{version:number;state:string;phase:string;error?:string}[];
}
export function TaskContextDetails({task}:{task:ContextDetail}){
  const zh=getLocale()==='zh-CN',label=(en:string,cn:string)=>zh?cn:en;
  const states:Record<string,string>=zh?{received:'已收到',accessed:'可访问',parsed:'已解析',failed:'失败',unsupported:'不支持',sent:'平台已接受',unknown:'结果未确认',pending:'等待交付',uploaded:'已上传'}:{received:'Received',accessed:'Accessible',parsed:'Parsed',failed:'Failed',unsupported:'Unsupported',sent:'Platform accepted',unknown:'Unconfirmed',pending:'Pending',uploaded:'Uploaded'};
  return <>
    {!!task.materials?.length&&<section><Heading as="h2" size="4">{label('Materials','材料读取')}</Heading>
      {task.materials.map((material,index)=><div className="result" key={index}>
        <Text as="p" size="2">{states[material.state]??material.state}{material.truncated?label(' · Limited',' · 已限制范围'):''}</Text>
        {material.nodes.map(node=><Text as="p" size="2" key={node.id}>{node.name??node.type} · {states[node.state]??node.state}{node.author?.name?` · ${node.author.name}`:''}{node.error?` · ${node.error}`:''}</Text>)}
        <details><summary>{label('Read limits and provenance','读取限制与来源')}</summary>{material.limitations.map((item,i)=><Text as="p" size="1" key={i}>{item}</Text>)}</details>
      </div>)}
    </section>}
    {!!task.artifacts?.length&&<section><Heading as="h2" size="4">{label('File delivery','文件交付')}</Heading>{task.artifacts.map(file=><div className="result" key={file.id}>
      <Text as="p" size="2">{file.path} · {states[file.state]??file.state}</Text><Text as="p" size="1" color="gray">{file.size??0} bytes · SHA-256 {file.sha256??'—'}</Text>
      {file.error&&<Text as="p" size="2" color="red">{file.error}</Text>}
    </div>)}</section>}
    {!!task.activity?.length&&<details><summary>{label('Execution activity and progress updates','执行活动与进度更新')}</summary>
      {task.activity.map((item,index)=><Text as="p" size="2" key={index}>{item.phase} · {new Date(item.updatedAt).toLocaleString(getLocale())}</Text>)}
      {task.progressUpdates?.slice(0,5).map(item=><Text as="p" size="1" key={item.version}>v{item.version} · {item.phase} · {item.state} {item.error??''}</Text>)}
    </details>}
  </>;
}
